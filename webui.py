"""把菜单编辑器的接口挂到 AstrBot WebUI 上。

所有路由都落在 /api/v1/plugins/extensions/astrbot_plugin_custom_menu/ 下，
鉴权直接复用 WebUI 的登录态，不再自己维护密钥登录页。

前端通过 AstrBot 注入的 window.AstrBotPluginPage 调用这些接口，
endpoint 只写相对部分，例如 apiGet("config")。
"""

import asyncio
import base64
import io
import json
import mimetypes
import re
import shutil
import time
import traceback
import uuid
import zipfile
from pathlib import Path
from typing import Optional
from urllib.parse import quote

from astrbot.api import logger
from quart import Response, request

from . import storage

PLUGIN_NAME = "astrbot_plugin_custom_menu"
ROUTE_PREFIX = f"/{PLUGIN_NAME}"

# 素材种类 -> PluginStorage 上的目录属性
# widget_img 是前端沿用的老叫法，一并认下来
ASSET_KINDS = {
    "background": "bg_dir",
    "icon": "icon_dir",
    "widget": "img_dir",
    "widget_img": "img_dir",
    "font": "fonts_dir",
    "video": "video_dir",
}

# 能生成缩略图的种类
THUMBNAIL_KINDS = {"background", "icon", "widget", "widget_img"}

# 素材面板里的缩略图边长，够看清就行，避免整张原图过桥
THUMB_MAX_PX = 160

# AstrBot 把插件接口放在一个 Quart 兼容层里跑，这一层沿用 Quart 默认的 16MB 请求体上限，
# 超过就直接 413。内置字体、视频、素材包都可能比这大，所以前端切成 4MB 一片逐片上传，这里拼回去
MAX_CHUNKS = 64
STALE_UPLOAD_SECONDS = 3600

# 上传的素材文件名都带随机前缀，同名即同内容，可以放心让浏览器缓存。
# 内置字体一个就二十来 MB，不缓存的话每次打开编辑器都要重新拉一遍
ASSET_CACHE_HEADERS = {"Cache-Control": "private, max-age=604800"}


# ---------------------------------------------------------------- 响应helpers


def ok(data=None):
    return {"status": "ok", "data": data if data is not None else {}}


def err(message: str, detail: str = ""):
    if detail:
        logger.error(f"[{PLUGIN_NAME}] {message}: {detail}")
    return {"status": "error", "message": message}


def _safe_name(name: str) -> Optional[str]:
    """挡掉 ../ 之类的路径穿越。"""
    if not name or "/" in name or "\\" in name or ".." in name:
        return None
    return name


def _asset_dir(kind: str) -> Optional[Path]:
    attr = ASSET_KINDS.get(kind)
    return getattr(storage.plugin_storage, attr, None) if attr else None


def _file_response(raw: bytes, filename: str, mimetype: str = "") -> Response:
    if not mimetype:
        mimetype = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    return Response(
        raw,
        mimetype=mimetype,
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"
        },
    )


def _thumbnail_b64(path: Path) -> str:
    """生成小尺寸预览图，素材面板用。存 PNG 保留透明，图标不会糊一块黑底。"""
    from PIL import Image

    with Image.open(path) as img:
        img = img.convert("RGBA")
    img.thumbnail((THUMB_MAX_PX, THUMB_MAX_PX))
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _image_size(path: Path) -> tuple:
    """只读文件头拿尺寸，编辑器要按背景图比例算画布高度。"""
    from PIL import Image

    try:
        with Image.open(path) as img:
            return img.size
    except OSError:
        return 0, 0


# ---------------------------------------------------------------- 注册入口


def register(plugin):
    """把所有接口注册到 WebUI。重复注册同一路由会覆盖，重载插件是安全的。"""
    context = plugin.context

    def api(route: str, methods: list, desc: str):
        def decorator(fn):
            context.register_web_api(f"{ROUTE_PREFIX}/{route}", fn, methods, desc)
            return fn

        return decorator

    def find_menu(menu_id: str) -> Optional[dict]:
        for menu in plugin.config.get("menus", []):
            if menu.get("id") == menu_id:
                return menu
        return None

    # ------------------------------------------------------------ 配置

    @api("config", ["GET"], "读取菜单配置")
    async def get_config():
        return ok(plugin.config)

    @api("config", ["POST"], "保存菜单配置")
    async def save_config():
        data = await request.get_json()
        if not isinstance(data, dict) or not isinstance(data.get("menus"), list):
            return err("配置格式不正确")

        store = storage.plugin_storage

        def _persist():
            store.save_config(data)
            store.cleanup_unused_caches(data["menus"])
            # 配置变了就把出图缓存全部作废，下次触发重新渲染
            for menu in data["menus"]:
                store.clear_menu_cache(menu.get("id"))

        await asyncio.to_thread(_persist)
        # 同进程，触发词改动立刻生效，不用等文件 mtime 轮询
        plugin.reload_config()
        return ok()

    # ------------------------------------------------------------ 指令列表

    @api("commands", ["GET"], "列出其它插件已注册的指令")
    async def get_commands():
        return ok(await asyncio.to_thread(plugin.collect_commands))

    # ------------------------------------------------------------ 素材

    @api("assets", ["GET"], "列出全部素材")
    async def list_assets():
        return ok(await asyncio.to_thread(storage.plugin_storage.get_assets_list))

    def find_asset(kind: str, name: str) -> Optional[Path]:
        target_dir = _asset_dir(kind)
        name = _safe_name(name)
        if target_dir is None or name is None:
            return None
        path = target_dir / name
        return path if path.is_file() else None

    @api("asset", ["GET"], "读取单个素材（base64）")
    async def get_asset():
        kind = request.args.get("kind", "")
        path = find_asset(kind, request.args.get("name", ""))
        if path is None:
            return err("素材不存在")

        try:
            if request.args.get("thumb") == "1" and kind in THUMBNAIL_KINDS:
                content = await asyncio.to_thread(_thumbnail_b64, path)
                return ok({"b64": content, "mime": "image/png"}), 200, ASSET_CACHE_HEADERS
            raw = await asyncio.to_thread(path.read_bytes)
            size = await asyncio.to_thread(_image_size, path) if kind in THUMBNAIL_KINDS else (0, 0)
        except Exception as e:
            return err(f"素材读取失败：{e}", traceback.format_exc())

        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        data = {"b64": base64.b64encode(raw).decode("ascii"), "mime": mime, "width": size[0], "height": size[1]}
        return ok(data), 200, ASSET_CACHE_HEADERS

    @api("asset/download", ["GET"], "下载素材原文件")
    async def download_asset():
        path = find_asset(request.args.get("kind", ""), request.args.get("name", ""))
        if path is None:
            return err("素材不存在"), 404
        return _file_response(await asyncio.to_thread(path.read_bytes), path.name)

    @api("upload/<kind>/<upload_id>/<index>/<total>", ["POST"], "分片上传素材")
    async def upload_asset(kind: str, upload_id: str, index: str, total: str):
        target_dir = _asset_dir(kind)
        if target_dir is None:
            return err(f"未知素材类型：{kind}")
        try:
            done = await _receive_chunk(upload_id, index, total)
        except ValueError as e:
            return err(str(e))
        if done is None:
            return ok({"received": int(index) + 1})

        original, part = done
        filename = f"{uuid.uuid4().hex[:8]}_{original}"
        await asyncio.to_thread(part.replace, target_dir / filename)
        # 素材换了，已有出图全部作废
        await asyncio.to_thread(_invalidate_all_caches, plugin)
        return ok({"filename": filename})

    @api("asset/delete", ["POST"], "删除素材")
    async def delete_asset():
        data = await request.get_json() or {}
        path = find_asset(data.get("kind", ""), data.get("name", ""))
        if path is None:
            return err("素材不存在")

        try:
            await asyncio.to_thread(path.unlink)
        except OSError as e:
            return err(f"删除失败：{e}")

        await asyncio.to_thread(_invalidate_all_caches, plugin)
        return ok()

    # ------------------------------------------------------------ 渲染 / 导出

    @api("preview", ["POST"], "服务端渲染真实预览图")
    async def render_preview():
        """用出图时同一套 Pillow 渲染，所见即所得，不再是 CSS 近似。"""
        menu = await request.get_json()
        if not isinstance(menu, dict):
            return err("菜单数据不正确")

        try:
            from .renderer.menu import render_static

            def _render() -> str:
                image = render_static(menu)
                buf = io.BytesIO()
                image.save(buf, "PNG")
                return base64.b64encode(buf.getvalue()).decode("ascii")

            return ok({"b64": await asyncio.to_thread(_render), "mime": "image/png"})
        except Exception as e:
            logger.error(f"[{PLUGIN_NAME}] 预览渲染失败: {traceback.format_exc()}")
            return err(f"预览渲染失败：{e}")

    async def render_saved(menu_id: str):
        """渲染已保存的菜单，返回 (菜单, 成品路径)；出错抛 ValueError 带可读原因。"""
        menu = find_menu(menu_id)
        if menu is None:
            raise ValueError("菜单不存在，请先保存配置")
        try:
            return menu, await plugin.render_menu(menu)
        except Exception as e:
            logger.error(f"[{PLUGIN_NAME}] 导出失败: {traceback.format_exc()}")
            raise ValueError(f"导出失败：{e}") from e

    # 下载走的是 blob，出错时宿主拿不到 JSON 里的 message，
    # 所以先用这个接口渲染并把错误原样报给前端，成功了再去下载缓存好的成品
    @api("export/prepare", ["POST"], "渲染菜单成品图，供随后下载")
    async def prepare_export():
        data = await request.get_json() or {}
        try:
            menu, path = await render_saved(data.get("id", ""))
        except ValueError as e:
            return err(str(e))
        return ok({"filename": f"{menu.get('name') or 'menu'}{path.suffix}"})

    @api("export", ["GET"], "导出菜单成品图")
    async def export_image():
        try:
            menu, path = await render_saved(request.args.get("id", ""))
        except ValueError as e:
            # 非 2xx 才能让宿主的下载失败，否则会把这段 JSON 当成图片存下来
            return err(str(e)), 500
        raw = await asyncio.to_thread(path.read_bytes)
        return _file_response(raw, f"{menu.get('name') or 'menu'}{path.suffix}")

    # ------------------------------------------------------------ 素材包

    @api("pack/export", ["GET"], "把菜单和它用到的素材打包导出")
    async def export_pack():
        menu = find_menu(request.args.get("id", ""))
        if menu is None:
            return err("菜单不存在，请先保存配置"), 404

        try:
            raw = await asyncio.to_thread(_build_pack, menu)
        except Exception as e:
            logger.error(f"[{PLUGIN_NAME}] 打包失败: {traceback.format_exc()}")
            return err(f"打包失败：{e}"), 500

        return _file_response(raw, f"{menu.get('name') or 'menu'}.zip", "application/zip")

    @api("pack/import/<upload_id>/<index>/<total>", ["POST"], "分片导入菜单素材包")
    async def import_pack(upload_id: str, index: str, total: str):
        try:
            done = await _receive_chunk(upload_id, index, total)
        except ValueError as e:
            return err(str(e))
        if done is None:
            return ok({"received": int(index) + 1})

        _, part = done
        try:
            new_menu = await asyncio.to_thread(_extract_pack, part)
        except Exception as e:
            logger.error(f"[{PLUGIN_NAME}] 导入失败: {traceback.format_exc()}")
            return err(f"导入失败：{e}")
        finally:
            part.unlink(missing_ok=True)

        config = plugin.config
        config.setdefault("menus", []).append(new_menu)
        await asyncio.to_thread(storage.plugin_storage.save_config, config)
        plugin.reload_config()
        return ok({"name": new_menu["name"]})

    logger.info(f"[{PLUGIN_NAME}] WebUI 接口已注册")


# ---------------------------------------------------------------- 内部实现


async def _receive_chunk(upload_id: str, index: str, total: str) -> Optional[tuple]:
    """收下一片。最后一片到齐时返回 (原始文件名, 拼好的临时文件)，否则返回 None。

    前端是一片接一片顺序发的，所以这里直接追加写。
    """
    if not re.fullmatch(r"[A-Za-z0-9]{6,40}", upload_id) or not (index.isdigit() and total.isdigit()):
        raise ValueError("上传参数不正确")
    index, total = int(index), int(total)
    if not 0 <= index < total <= MAX_CHUNKS:
        raise ValueError("文件太大或上传参数不正确")

    files = await request.files
    upload = files.get("file")
    if upload is None:
        raise ValueError("没有收到文件")
    # 不能用 upload.save：Quart 的 save 是协程，丢进线程里跑只会生成一个没人 await 的协程，
    # 接口照样返回成功，文件却根本没写到磁盘上
    raw = await asyncio.to_thread(upload.read)

    tmp_dir = storage.plugin_storage.data_dir / "uploads"
    part = tmp_dir / f"{upload_id}.part"

    def _write():
        tmp_dir.mkdir(exist_ok=True)
        if index == 0:
            _drop_stale_parts(tmp_dir)
        elif not part.exists():
            raise ValueError("前面的分片丢了，请重新上传")
        with open(part, "wb" if index == 0 else "ab") as f:
            f.write(raw)

    await asyncio.to_thread(_write)
    if index + 1 < total:
        return None
    if part.stat().st_size == 0:
        part.unlink()
        raise ValueError("上传的文件是空的")
    return _safe_name(Path(upload.filename or "").name) or "upload.bin", part


def _drop_stale_parts(tmp_dir: Path):
    """清掉中途放弃的上传留下的半截文件。"""
    deadline = time.time() - STALE_UPLOAD_SECONDS
    for stale in tmp_dir.glob("*.part"):
        try:
            if stale.stat().st_mtime < deadline:
                stale.unlink()
        except OSError:
            pass


def _invalidate_all_caches(plugin):
    store = storage.plugin_storage
    for menu in plugin.config.get("menus", []):
        store.clear_menu_cache(menu.get("id"))


# 打包时要一起带走的字体字段：菜单全局 / 分组 / 功能项三级
_FONT_KEYS = (
    "title_font",
    "subtitle_font",
    "group_title_font",
    "group_sub_font",
    "item_name_font",
    "item_desc_font",
)
_GROUP_FONT_KEYS = ("title_font", "sub_font", "text_font")
_ITEM_FONT_KEYS = ("name_font", "desc_font")

# zip 内目录 -> PluginStorage 目录属性
_PACK_DIRS = {
    "assets/backgrounds": "bg_dir",
    "assets/videos": "video_dir",
    "assets/fonts": "fonts_dir",
    "assets/icons": "icon_dir",
    "assets/widgets": "img_dir",
}


def _build_pack(menu: dict) -> bytes:
    store = storage.plugin_storage
    buf = io.BytesIO()
    fonts = set()

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("menu.json", json.dumps(menu, indent=2, ensure_ascii=False))

        def add(filename: str, folder: str, source_dir: Path):
            if not filename:
                return
            src = source_dir / filename
            if src.is_file():
                zf.write(src, arcname=f"assets/{folder}/{filename}")

        for bg in [menu.get("background")] + list(menu.get("backgrounds") or []):
            add(bg, "backgrounds", store.bg_dir)
        add(menu.get("bg_video"), "videos", store.video_dir)

        fonts.update(menu.get(key) for key in _FONT_KEYS)
        for group in menu.get("groups", []):
            fonts.update(group.get(key) for key in _GROUP_FONT_KEYS)
            for item in group.get("items", []):
                add(item.get("icon"), "icons", store.icon_dir)
                fonts.update(item.get(key) for key in _ITEM_FONT_KEYS)

        for widget in menu.get("custom_widgets", []):
            if widget.get("type") == "image":
                add(widget.get("content"), "widgets", store.img_dir)
            fonts.add(widget.get("font"))

        # 插件自带的字体每个实例都有，不打进包里，不然包凭空大出三十多 MB
        builtin = {p.name for p in (store.base_dir / "fonts").glob("*.*")}
        for font in fonts - builtin:
            add(font, "fonts", store.fonts_dir)

    return buf.getvalue()


def _extract_pack(pack: Path) -> dict:
    store = storage.plugin_storage

    with zipfile.ZipFile(pack) as zf:
        if "menu.json" not in zf.namelist():
            raise ValueError("不是合法的素材包：缺少 menu.json")

        menu = json.loads(zf.read("menu.json").decode("utf-8"))
        menu["id"] = f"m_imp_{int(time.time() * 1000)}"
        menu["name"] = f"{menu.get('name', 'Imported')} (导入)"

        for info in zf.infolist():
            if info.is_dir() or info.filename == "menu.json":
                continue
            folder = str(Path(info.filename).parent).replace("\\", "/")
            attr = _PACK_DIRS.get(folder)
            if not attr:
                continue
            # 只取文件名，杜绝 zip 里带路径穿越
            name = _safe_name(Path(info.filename).name)
            if not name:
                continue
            target = getattr(store, attr) / name
            with zf.open(info) as source, open(target, "wb") as dest:
                shutil.copyfileobj(source, dest)

    return menu
