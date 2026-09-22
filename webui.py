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
    """生成小尺寸预览图，素材面板用。"""
    from PIL import Image

    with Image.open(path) as img:
        img = img.convert("RGB")
        img.thumbnail((THUMB_MAX_PX, THUMB_MAX_PX))
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=70)
    return base64.b64encode(buf.getvalue()).decode("ascii")


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

    @api("asset", ["GET"], "读取单个素材（base64）")
    async def get_asset():
        kind = request.args.get("kind", "")
        name = _safe_name(request.args.get("name", ""))
        want_thumb = request.args.get("thumb") == "1"

        target_dir = _asset_dir(kind)
        if target_dir is None or name is None:
            return err("素材参数不正确")

        path = target_dir / name
        if not path.is_file():
            return err("素材不存在")

        try:
            if want_thumb and kind in THUMBNAIL_KINDS:
                content = await asyncio.to_thread(_thumbnail_b64, path)
                return ok({"b64": content, "mime": "image/jpeg"})
            raw = await asyncio.to_thread(path.read_bytes)
        except Exception as e:
            return err(f"素材读取失败：{e}", traceback.format_exc())

        mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
        return ok({"b64": base64.b64encode(raw).decode("ascii"), "mime": mime})

    @api("upload/<kind>", ["POST"], "上传素材")
    async def upload_asset(kind: str):
        target_dir = _asset_dir(kind)
        if target_dir is None:
            return err(f"未知素材类型：{kind}")

        files = await request.files
        upload = files.get("file")
        if upload is None:
            return err("没有收到文件")

        original = _safe_name(Path(upload.filename or "").name) or "upload.bin"
        filename = f"{uuid.uuid4().hex[:8]}_{original}"
        await asyncio.to_thread(upload.save, str(target_dir / filename))

        # 素材换了，已有出图全部作废
        await asyncio.to_thread(_invalidate_all_caches, plugin)
        return ok({"filename": filename})

    @api("asset/delete", ["POST"], "删除素材")
    async def delete_asset():
        data = await request.get_json() or {}
        kind = data.get("kind", "")
        name = _safe_name(data.get("name", ""))

        target_dir = _asset_dir(kind)
        if target_dir is None or name is None:
            return err("素材参数不正确")

        path = target_dir / name
        if not path.is_file():
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

    @api("export", ["GET"], "导出菜单成品图")
    async def export_image():
        menu = find_menu(request.args.get("id", ""))
        if menu is None:
            return err("菜单不存在，请先保存配置")

        try:
            path = await plugin.render_menu(menu)
            raw = await asyncio.to_thread(path.read_bytes)
        except Exception as e:
            logger.error(f"[{PLUGIN_NAME}] 导出失败: {traceback.format_exc()}")
            return err(f"导出失败：{e}")

        return _file_response(raw, f"{menu.get('name') or 'menu'}{path.suffix}")

    # ------------------------------------------------------------ 素材包

    @api("pack/export", ["GET"], "把菜单和它用到的素材打包导出")
    async def export_pack():
        menu = find_menu(request.args.get("id", ""))
        if menu is None:
            return err("菜单不存在，请先保存配置")

        try:
            raw = await asyncio.to_thread(_build_pack, menu)
        except Exception as e:
            logger.error(f"[{PLUGIN_NAME}] 打包失败: {traceback.format_exc()}")
            return err(f"打包失败：{e}")

        return _file_response(raw, f"{menu.get('name') or 'menu'}.zip", "application/zip")

    @api("pack/import", ["POST"], "导入菜单素材包")
    async def import_pack():
        files = await request.files
        upload = files.get("file")
        if upload is None:
            return err("没有收到文件")

        try:
            raw = await asyncio.to_thread(upload.read)
            new_menu = await asyncio.to_thread(_extract_pack, raw)
        except Exception as e:
            logger.error(f"[{PLUGIN_NAME}] 导入失败: {traceback.format_exc()}")
            return err(f"导入失败：{e}")

        config = plugin.config
        config.setdefault("menus", []).append(new_menu)
        await asyncio.to_thread(storage.plugin_storage.save_config, config)
        plugin.reload_config()
        return ok({"name": new_menu["name"]})

    logger.info(f"[{PLUGIN_NAME}] WebUI 接口已注册")


# ---------------------------------------------------------------- 内部实现


def _invalidate_all_caches(plugin):
    store = storage.plugin_storage
    for menu in plugin.config.get("menus", []):
        store.clear_menu_cache(menu.get("id"))


# 打包时要一起带走的字体字段
_FONT_KEYS = (
    "title_font",
    "group_title_font",
    "group_sub_font",
    "item_name_font",
    "item_desc_font",
)

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
            fonts.update(group.get(key) for key in ("title_font", "group_title_font", "group_sub_font"))
            for item in group.get("items", []):
                add(item.get("icon"), "icons", store.icon_dir)
                fonts.update((item.get("name_font"), item.get("desc_font")))

        for widget in menu.get("custom_widgets", []):
            if widget.get("type") == "image":
                add(widget.get("content"), "widgets", store.img_dir)
            fonts.add(widget.get("font"))

        for font in fonts:
            add(font, "fonts", store.fonts_dir)

    return buf.getvalue()


def _extract_pack(raw: bytes) -> dict:
    store = storage.plugin_storage

    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
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
