using MapleBench.Models;
using MapleBench.Services;

namespace MapleBench.Api;

/// <summary>
/// The Item editor's HTTP surface, wired with <c>MapItems(api)</c>.
///
/// Reads (capabilities / paged list / detail) come from
/// <see cref="ItemService"/>; writes go through the shared node-editing routes
/// (<c>PUT /api/node/value</c> for a single field, <c>POST /api/item/bulk</c>
/// for a SetOrCreate batch) and save through the shared
/// <c>POST /api/files/save</c> — so item edits share one dirty state, one undo
/// history and one save pipeline with the Explorer.
/// </summary>
public static class ItemEndpoints
{
    public static void MapItems(this RouteGroupBuilder api)
    {
        api.MapGet("/item/capabilities", (ItemService items, StringPoolService strings) =>
            Results.Ok(new
            {
                available = items.IsAvailable,
                names = strings.HasSource,
            }));

        api.MapGet("/item/list", (string? fileId, int? offset, int? limit,
            string? search, string? category, bool? cash, bool? tradeBlock,
            int? minReq, int? maxReq, bool? dirtyOnly,
            ItemService items, CancellationToken cancel) =>
        {
            ItemListDto page = items.List(
                fileId, offset ?? 0, limit ?? 200,
                search, category, cash, tradeBlock, minReq, maxReq, dirtyOnly, cancel);
            return Results.Ok(page);
        });

        api.MapGet("/item/detail", (string path, ItemService items) =>
            Results.Ok(items.Detail(path)));

        api.MapPost("/item/bulk", (ItemBulkRequest request, ItemService items) =>
            Results.Ok(items.Bulk(request)));

        api.MapDelete("/item/field", (string path, string key, ItemService items) =>
        {
            try
            {
                items.RemoveField(path, key);
                return Results.Ok(new { ok = true });
            }
            catch (Exception ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });

        api.MapPost("/item/icon", (ItemIconRequest request, ItemService items) =>
        {
            try
            {
                byte[] png = Convert.FromBase64String(request.PngBase64);
                return Results.Ok(items.ReplaceIcon(request.Path, request.Key, png));
            }
            catch (FormatException)
            {
                return Results.BadRequest(new { error = "图片数据不是有效的 base64。" });
            }
        });
    }
}
