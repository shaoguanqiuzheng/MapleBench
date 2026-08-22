using System.Diagnostics;

namespace MapleBench.Services;

/// <summary>
/// Builds the section indexes in the background, while the user is still
/// looking at the file tree.
///
/// The cost this hides is real and measured on a v232 client (29 archives):
/// the string pool takes 2.6s, the mob list 7.5s, the skill list 8.1s and the
/// NPC list 3.3s to build the first time. Each is correctly cached against
/// <see cref="WzSessionService.Generation"/>, so it is once per generation - but
/// paid on demand it lands as a twenty-second freeze the first time the user
/// clicks Skills. Opening a client is the first moment we know all of that may
/// be wanted, but it is also when the user is most likely to start navigating.
/// The work therefore begins only after a short quiet period and every API
/// request pushes it back again.
///
/// Three properties this must have, and does:
///
///   * it never blocks the request that starts it - <c>/api/files/open-many</c>
///     returns as soon as the archives are open;
///   * it is cancellable, and is cancelled by anything that would invalidate
///     what it is building (another open, a close, a save) so it cannot sit
///     there rebuilding a tree that has moved on;
///   * it holds the session gate only in the same short chunks an interactive
///     build does, because it calls exactly the same builders. A request cancels
///     the pass before entering its endpoint, so foreground work always wins.
/// </summary>
public sealed class WarmupService : IDisposable
{
    private readonly WzSessionService _session;
    private readonly StringPoolService _strings;
    private readonly MobService _mobs;
    private readonly NpcService _npcs;
    private readonly SkillService _skills;
    private readonly ImageMemoryService _memory;
    private readonly ILogger<WarmupService> _log;

    private readonly object _gate = new();
    private CancellationTokenSource? _cancel;
    private Task? _running;
    private int _foregroundRequests;
    private bool _disposed;

    /// <summary>
    /// A deliberate pause after the last request. Long enough to cover the burst
    /// of capability and file-list calls made after opening a client, short
    /// enough that an untouched app still has warm indexes before the user has
    /// finished orienting themselves.
    /// </summary>
    private static readonly TimeSpan IdleDelay = TimeSpan.FromMilliseconds(1500);

    public WarmupService(
        WzSessionService session, StringPoolService strings, MobService mobs,
        NpcService npcs, SkillService skills, ImageMemoryService memory, ILogger<WarmupService> log)
    {
        _session = session;
        _strings = strings;
        _mobs = mobs;
        _npcs = npcs;
        _skills = skills;
        _memory = memory;
        _log = log;
    }

    public bool Enabled { get; set; } = true;

    public void BeginForeground()
    {
        lock (_gate)
        {
            if (!Enabled || _disposed)
                return;

            _foregroundRequests++;
            CancelLocked();
        }
    }

    public IDisposable HoldForeground()
    {
        BeginForeground();
        return new ForegroundLease(this);
    }

    public void EndForeground()
    {
        lock (_gate)
        {
            if (_foregroundRequests == 0)
                return;

            _foregroundRequests--;
            if (_foregroundRequests == 0 && Enabled && !_disposed)
                ScheduleLocked();
        }
    }

    private void ScheduleLocked()
    {
        CancelLocked();

        CancellationTokenSource next = new();
        Task? previous = _running;
        _cancel = next;

        _running = Task.Run(async () =>
        {
            if (previous != null)
            {
                try { await previous.ConfigureAwait(false); }
                catch { }
            }

            try
            {
                await Task.Delay(IdleDelay, next.Token).ConfigureAwait(false);
                Run(next.Token);
            }
            catch (OperationCanceledException)
            {
            }
        });
    }

    public void Cancel()
    {
        lock (_gate)
            CancelLocked();
    }

    private void CancelLocked()
    {
        _cancel?.Cancel();
        _cancel = null;
    }

    public bool CancelAndWait(TimeSpan budget)
    {
        Task? running;
        lock (_gate)
        {
            CancelLocked();
            running = _running;
        }

        if (running == null || running.IsCompleted)
            return true;

        try
        {
            return running.Wait(budget);
        }
        catch (AggregateException)
        {
            return true;
        }
    }

    private void Run(CancellationToken cancel)
    {
        Stopwatch clock = Stopwatch.StartNew();
        try
        {
            if (_session.FileCount == 0)
                return;

            Step("string pool", cancel, () =>
                _strings.Warm(cancel, allowExclusiveFallback: false));

            if (_npcs.IsAvailable)
            {
                Step("npc list", cancel, () =>
                    _npcs.List(null, true, cancel, allowExclusiveFallback: false));
                Step("sweep", cancel, () => _memory.SweepIfHeavy(cancel));
            }
            // Mob list is deliberately NOT pre-built here. On an IMG-folder client
            // (v83 data as loose .img files) building it parses every mob image;
            // the first foreground request already pays that once and caches the
            // result, and a second background pass duplicates the parse with no
            // cache to share, which measured 8+ GB of retained LOH on a v83 Mob
            // folder. The on-demand path serves the cached list in ~100 ms.
            if (_skills.IsAvailable)
            {
                Step("skill list", cancel, () =>
                    _skills.List(null, null, true, cancel, allowExclusiveFallback: false));
            }

            if (cancel.IsCancellationRequested)
                return;

            SweepReportDto report = _memory.SweepIfHeavy(cancel);

            _log.LogInformation(
                "Warm-up finished in {Ms} ms; released {Swept} images, {Before} MB -> {After} MB",
                clock.ElapsedMilliseconds, report.Swept, report.WorkingSetBeforeMB, report.WorkingSetAfterMB);
        }
        catch (OperationCanceledException)
        {
            _log.LogDebug("Warm-up cancelled after {Ms} ms", clock.ElapsedMilliseconds);
        }
        catch (Exception ex)
        {
            _log.LogDebug(ex, "Warm-up stopped early");
        }
    }

    private void Step(string what, CancellationToken cancel, Action work)
    {
        if (cancel.IsCancellationRequested)
            return;

        Stopwatch clock = Stopwatch.StartNew();
        try
        {
            work();
            _log.LogDebug("Warmed {What} in {Ms} ms", what, clock.ElapsedMilliseconds);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _log.LogDebug(ex, "Could not warm {What}", what);
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed)
                return;

            _disposed = true;
            CancelLocked();
        }
    }

    private sealed class ForegroundLease : IDisposable
    {
        private WarmupService? _owner;

        public ForegroundLease(WarmupService owner) => _owner = owner;

        public void Dispose() => Interlocked.Exchange(ref _owner, null)?.EndForeground();
    }
}
