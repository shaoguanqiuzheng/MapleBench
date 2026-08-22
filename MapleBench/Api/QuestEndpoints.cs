using MapleBench.Models;
using MapleBench.Services;

namespace MapleBench.Api;

/// <summary>
/// The Quest editor's HTTP surface, wired with <c>MapQuests(api)</c>.
///
/// Shapes mirror <c>/api/skill/*</c>: a capabilities call, a (paged) browse
/// list, a detail, and a whole-quest save. The save carries the full quest
/// shape and replaces the four WZ subtrees in one undo batch — see
/// <see cref="QuestService.Save"/>.
/// </summary>
public static class QuestEndpoints
{
    public static void MapQuests(this RouteGroupBuilder api)
    {
        api.MapGet("/quest/capabilities", (QuestService quests) =>
            Results.Ok(new
            {
                available = quests.IsAvailable,
            }));

        api.MapGet("/quest/list", (string? fileId, int? offset, int? limit,
            QuestService quests, CancellationToken cancel) =>
        {
            if (offset is null && limit is null)
                return Results.Ok(quests.List(fileId, cancel));

            (QuestListDto page, int total) = quests.Page(
                fileId, offset ?? 0, limit ?? 200, cancel);
            return Results.Ok(new
            {
                quests = page.Quests,
                stats = page.Stats,
                truncated = page.Truncated,
                total,
                offset = offset ?? 0,
                limit = limit ?? 200,
            });
        });

        api.MapGet("/quest/detail", (string path, QuestService quests) =>
            Results.Ok(quests.Detail(path)));

        api.MapPost("/quest/save", (QuestSaveRequest request, QuestService quests) =>
            Results.Ok(quests.Save(request)));
    }
}
