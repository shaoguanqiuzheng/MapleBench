using MapleLib.WzLib;
using MapleBench.Models;
using MapleLib.Img;

namespace MapleBench.Services;

/// <summary>
/// One entry in the session: a parsed .wz archive, a .ms archive that was
/// converted to one, a loose .img, or a mounted folder of loose images.
/// </summary>
public sealed class OpenFile : IDisposable
{
    public string Id { get; }

    /// <summary>Display name, e.g. "Etc.wz".</summary>
    public string Name { get; set; }

    /// <summary>Absolute path the file was loaded from.</summary>
    public string FilePath { get; set; }

    /// <summary>"wz", "ms", "img", "img-folder", or "split".</summary>
    public string Kind { get; }

    /// <summary>
    /// Set only for <c>Kind == "split"</c>: the merged tree's backing files.
    ///
    /// A split archive is not a file on disk, it is a directory of them merged in
    /// memory, and every image in <see cref="WzFile"/> reads its bytes through a
    /// reader that this object owns. Holding it here is what makes closing the
    /// entry release sixty-six file handles and a gigabyte of pack buffers instead
    /// of leaking them for the life of the process — <see cref="Dispose"/> is the
    /// only place that knows both halves exist.
    /// </summary>
    public AssembledArchive? Assembled { get; set; }

    /// <summary>Null for loose .img entries.</summary>
    public WzFile? WzFile { get; set; }

    /// <summary>Set for loose .img entries; null otherwise.</summary>
    public WzImage? LooseImage { get; set; }

    /// <summary>Set for an IMG-folder mount; null for physical archives and files.</summary>
    public VirtualWzDirectory? FolderRoot { get; set; }

    /// <summary>Owns the lazy readers and image cache behind <see cref="FolderRoot"/>.</summary>
    public ImgFileSystemManager? ImgFolderManager { get; set; }

    /// <summary>The directory-shaped root, whether it came from WZ or the filesystem.</summary>
    public WzDirectory? RootDirectory => WzFile?.WzDirectory ?? FolderRoot;

    public WzMapleVersion MapleVersion { get; set; }

    public byte[]? CustomIv { get; set; }

    /// <summary>
    /// Whether this archive holds work that is not on disk.
    ///
    /// It covers the changes no <see cref="WzImage.Changed"/> flag can: adding,
    /// removing, renaming and reordering images and directories all move the
    /// archive without any single image reporting itself dirty.
    /// <see cref="CountDirtyImages"/> covers the other half, and
    /// <see cref="ToDto"/> is where the two meet.
    ///
    /// It is a two-way flag, and the round trip matters.  Set by
    /// <c>WzEditService.MarkFileDirty</c> on every mutation; put back in step
    /// with the undo stack by <c>WzEditService.SyncDirty</c> after an undo or
    /// redo — which is what lets a fully-undone archive report clean again; and
    /// cleared by <see cref="WzSaveService"/> once the bytes are down.  Treat it
    /// as load-bearing rather than cosmetic: it decides whether the close prompt
    /// fires and whether a second launch may kill this process.
    /// </summary>
    public bool Dirty { get; set; }

    /// <summary>
    /// Open for reference only: every mutation below this file is refused.
    ///
    /// The workflow this exists for is having two clients open at once — a live
    /// one and an older one you are porting a change out of. The archives are
    /// named the same, the tree rows look the same, and the icon and string pools
    /// deliberately merge them, so editing the wrong one is easy and is not
    /// noticed until the dirty count is on the archive you meant to read.
    /// Refusing the write is cheaper than detecting the mistake afterwards.
    /// </summary>
    public bool ReadOnly { get; set; }

    public OpenFile(string id, string name, string filePath, string kind)
    {
        Id = id;
        Name = name;
        FilePath = filePath;
        Kind = kind;
    }

    /// <summary>The object that path "&lt;id&gt;" resolves to.</summary>
    /// <summary>
    /// True when the underlying archive was released and could not be reopened.
    /// The entry stays in the list so the user can see and close it.
    /// </summary>
    public bool Detached { get; set; }

    public WzObject Root
    {
        get
        {
            WzObject? root = (WzObject?)RootDirectory ?? LooseImage;
            if (root != null)
                return root;

            // Without this the null slipped through `!` and every later request
            // for this file died with an opaque 500.
            throw new InvalidOperationException(
                $"'{Name}' is no longer loaded. A save released it and it could not be reopened. " +
                "Close it and open it again.");
        }
    }

    public bool Is64Bit => WzFile?.Is64BitWzFile ?? false;

    public short GameVersion => WzFile?.Version ?? 0;

    /// <summary>
    /// Number of WzImages below this file that carry unsaved changes.  Loose
    /// .img entries report 1 or 0.
    ///
    /// This is a live read of MapleLib's own flags, not a cached count, so it
    /// follows an undo down to zero — <see cref="ImageChangeLog"/> restores each
    /// image's flag to what the edit found.  Without that it never fell, and an
    /// archive whose every edit had been undone still re-serialised every image
    /// it had ever touched on the next save.
    /// </summary>
    public int CountDirtyImages()
    {
        // A split archive is never dirty, and counting would say otherwise.
        //
        // Images that came out of a .ms pack carry Changed = true, which in that
        // context means "there is no block on disk to copy, so serialise me" and
        // not "the user edited this". Counting them made a freshly opened Mob
        // report 11,979 unsaved changes on an archive that is read-only and has no
        // file to be saved to — enough to fire the close prompt, mark the client
        // dirty in the Port panel, and invite the one action that must never
        // happen here.
        if (Kind == "split")
            return 0;

        // An IMG folder counts like an archive: images parsed from disk start
        // clean and only become Changed when an edit touches them, so the count
        // is the real dirty set. (SaveImgFolder writes each changed .img back to
        // its own file.) The directory's own entries are placeholders that never
        // carry the flag — the edited instance lives in the file manager's
        // cache — so the walk resolves each entry through the manager.
        if (Kind == "img-folder")
        {
            if (ImgFolderManager == null || FolderRoot == null)
                return 0;
            int count = 0;
            CountDirtyImages(FolderRoot, ImgFolderManager, Path.GetFileName(FilePath), string.Empty, ref count);
            return count;
        }

        if (LooseImage != null)
            return LooseImage.Changed ? 1 : 0;
        if (RootDirectory == null)
            return 0;

        int total = 0;
        CountDirtyImages(RootDirectory, ref total);
        return total;
    }

    private static void CountDirtyImages(WzDirectory dir, ref int count)
    {
        foreach (WzImage image in dir.WzImages)
        {
            if (image.Changed)
                count++;
        }
        foreach (WzDirectory sub in dir.WzDirectories)
            CountDirtyImages(sub, ref count);
    }

    /// <summary>The IMG-folder variant: resolves each placeholder through the
    /// file manager's cache, where the edited instance lives.
    ///
    /// Cache-only by design: an image that was never loaded cannot have been
    /// edited, and a dirty count over a whole client must not parse tens of
    /// thousands of .img files just to ask.</summary>
    private static void CountDirtyImages(WzDirectory dir, MapleLib.Img.ImgFileSystemManager manager,
        string category, string prefix, ref int count)
    {
        foreach (WzImage placeholder in dir.WzImages)
        {
            string relativePath = string.IsNullOrEmpty(prefix)
                ? placeholder.Name
                : Path.Combine(prefix, placeholder.Name);
            WzImage? image = manager.TryGetCachedImage(category, relativePath);
            if (image != null && image.Changed)
                count++;
        }
        foreach (WzDirectory sub in dir.WzDirectories)
        {
            string subPrefix = string.IsNullOrEmpty(prefix) ? sub.Name : Path.Combine(prefix, sub.Name);
            CountDirtyImages(sub, manager, category, subPrefix, ref count);
        }
    }

    /// <summary>
    /// Every <see cref="WzImage"/> below this file, dirty or not.
    ///
    /// Loose .img entries are deliberately excluded: the caller this exists for
    /// (<see cref="ImageMemoryService"/>) releases parsed images so they can be
    /// re-read from the archive, and a loose image has no archive to be re-read
    /// from — its reader is its own file and its identity is the session entry.
    /// One image is not worth the special case.
    /// </summary>
    public IEnumerable<WzImage> EnumerateArchiveImages()
    {
        if (RootDirectory == null)
            yield break;

        // An IMG-folder's directory entries are placeholders that never carry a
        // parsed tree; the real instances live in the file manager's cache.
        // Enumerate those, cache-only — a sweep over a 44,000-file client must
        // not parse files just to ask whether they can be released, and an
        // image never loaded cannot be holding anything.
        if (Kind == "img-folder" && ImgFolderManager != null)
        {
            string category = Path.GetFileName(FilePath);
            foreach (WzImage image in EnumerateResolvedImages(RootDirectory, ImgFolderManager, category, string.Empty))
                yield return image;
            yield break;
        }

        Stack<WzDirectory> pending = new();
        pending.Push(RootDirectory);
        while (pending.Count > 0)
        {
            WzDirectory dir = pending.Pop();
            foreach (WzImage image in dir.WzImages)
                yield return image;
            foreach (WzDirectory sub in dir.WzDirectories)
                pending.Push(sub);
        }
    }

    public IEnumerable<WzImage> EnumerateDirtyImages()
    {
        if (LooseImage != null)
        {
            if (LooseImage.Changed)
                yield return LooseImage;
            yield break;
        }
        if (RootDirectory == null)
            yield break;

        // IMG-folder directory entries are placeholders that never carry
        // Changed; resolve each through the file manager's cache, where the
        // edited instance lives. Cache-only: an image never loaded cannot have
        // been edited, and a save of a whole client must not parse tens of
        // thousands of files to find the handful that changed.
        if (Kind == "img-folder" && ImgFolderManager != null)
        {
            string category = Path.GetFileName(FilePath);
            foreach (WzImage image in EnumerateResolvedImages(RootDirectory, ImgFolderManager, category, string.Empty))
            {
                if (image.Changed)
                    yield return image;
            }
            yield break;
        }

        Stack<WzDirectory> pending = new();
        pending.Push(RootDirectory);
        while (pending.Count > 0)
        {
            WzDirectory dir = pending.Pop();
            foreach (WzImage image in dir.WzImages)
            {
                if (image.Changed)
                    yield return image;
            }
            foreach (WzDirectory sub in dir.WzDirectories)
                pending.Push(sub);
        }
    }

    private static IEnumerable<WzImage> EnumerateResolvedImages(WzDirectory dir,
        MapleLib.Img.ImgFileSystemManager manager, string category, string prefix)
    {
        foreach (WzImage placeholder in dir.WzImages)
        {
            string relativePath = string.IsNullOrEmpty(prefix)
                ? placeholder.Name
                : Path.Combine(prefix, placeholder.Name);
            WzImage? image = manager.TryGetCachedImage(category, relativePath);
            if (image != null)
                yield return image;
        }
        foreach (WzDirectory sub in dir.WzDirectories)
        {
            string subPrefix = string.IsNullOrEmpty(prefix) ? sub.Name : Path.Combine(prefix, sub.Name);
            foreach (WzImage image in EnumerateResolvedImages(sub, manager, category, subPrefix))
                yield return image;
        }
    }

    public OpenFileDto ToDto()
    {
        int dirtyCount = CountDirtyImages();
        return new OpenFileDto
        {
            Id = Id,
            Name = Name,
            FilePath = FilePath,
            Kind = Kind,
            MapleVersion = MapleVersion.ToString(),
            GameVersion = GameVersion,
            Is64Bit = Is64Bit,
            Dirty = Dirty || dirtyCount > 0,
            DirtyNodeCount = dirtyCount,
            Detached = Detached,
            ReadOnly = ReadOnly,
        };
    }

    public void Dispose()
    {
        if (Assembled != null)
        {
            // Disposes the merged tree and then every source behind it, in that
            // order. Calling WzFile.Dispose() as well would be a second pass over
            // a tree whose images have already had their readers closed, so the
            // two paths are exclusive rather than cumulative.
            Assembled.Dispose();
            Assembled = null;
        }
        else
        {
            WzFile?.Dispose();
        }
        FolderRoot?.Dispose();
        ImgFolderManager?.Dispose();
        LooseImage?.Dispose();
        WzFile = null;
        LooseImage = null;
        FolderRoot = null;
        ImgFolderManager = null;
    }
}
