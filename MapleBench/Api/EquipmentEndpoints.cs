using MapleBench.Models;
using MapleBench.Services;

namespace MapleBench.Api;

/// <summary>
/// The Equipment editor's HTTP surface, wired with <c>MapEquipment(api)</c>.
///
/// Reads come from <see cref="EquipmentService"/>; writes go through the shared
/// node-editing routes (<c>PUT /api/node/value</c>, <c>POST /api/equip/bulk</c>)
/// and save through the shared <c>POST /api/files/save</c> — so equipment edits
/// share one dirty state, one undo history and one save pipeline with the rest
/// of the app.
/// </summary>
public static class EquipmentEndpoints
{
    public static void MapEquipment(this RouteGroupBuilder api)
    {
        api.MapGet("/equip/capabilities", (EquipmentService equips, StringPoolService strings) =>
            Results.Ok(new
            {
                available = equips.IsAvailable,
                names = strings.HasSource,
            }));

        api.MapGet("/equip/list", (string? fileId, int? offset, int? limit,
            string? part, string? search, bool? dirtyOnly,
            EquipmentService equips, CancellationToken cancel) =>
        {
            EquipmentListDto page = equips.List(
                fileId, offset ?? 0, limit ?? 200,
                part, search, dirtyOnly, cancel);
            return Results.Ok(page);
        });

        api.MapGet("/equip/detail", (string path, EquipmentService equips) =>
            Results.Ok(equips.Detail(path)));

        api.MapPost("/equip/bulk", (ItemBulkRequest request, EquipmentService equips) =>
            Results.Ok(equips.Bulk(request)));

        api.MapDelete("/equip/field", (string path, string relPath, EquipmentService equips) =>
        {
            try
            {
                equips.RemoveField(path, relPath);
                return Results.Ok(new { ok = true });
            }
            catch (Exception ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });

        api.MapPost("/equip/level", (AddLevelRequest request, EquipmentService equips) =>
        {
            try
            {
                int created = equips.AddLevel(request.Path, request.Level);
                return Results.Ok(new { level = created });
            }
            catch (Exception ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });

        api.MapDelete("/equip/level", (string path, int level, EquipmentService equips) =>
        {
            try
            {
                equips.RemoveLevel(path, level);
                return Results.Ok(new { ok = true });
            }
            catch (Exception ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });

        api.MapPost("/equip/icon", (ItemIconRequest request, EquipmentService equips) =>
        {
            try
            {
                byte[] png = Convert.FromBase64String(request.PngBase64);
                return Results.Ok(equips.ReplaceIcon(request.Path, request.Key, png));
            }
            catch (FormatException)
            {
                return Results.BadRequest(new { error = "图片数据不是有效的 base64。" });
            }
        });
    }
}
