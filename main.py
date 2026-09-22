"""AstrBot 可视化菜单插件。

编辑面板已内嵌进 AstrBot WebUI（插件管理 →「菜单编辑器」），
不再单独监听端口，也不再 fork 子进程。
"""

import asyncio
import collections
import random
import re
import time
import traceback
from pathlib import Path
from typing import Dict, List, Optional

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.message_components import File, Plain
from astrbot.api.star import Context, Star, register
from astrbot.core.star.filter.command import CommandFilter
from astrbot.core.star.filter.command_group import CommandGroupFilter
from astrbot.core.star.star_handler import StarHandlerMetadata, star_handlers_registry

from . import storage, webui

PLUGIN_NAME = "astrbot_plugin_custom_menu"

# 正式指令走 CommandFilter：精确匹配，不会让机器人对每条消息都唤醒。
MENU_COMMAND = "菜单"
MENU_ALIASES = {"功能", "帮助", "指令", "列表", "说明书", "help", "menu"}

# 自然语言兜底。注册时 priority 为负，排在所有普通 handler 之后，
# 保证不会抢掉别的插件的指令。
NATURAL_LANGUAGE = re.compile(
    r"(?i)^\s*(?:这个|你|bot)?\s*(?:"
    r"(?:怎么|如何|咋)\s*(?:用|使用|操作)"
    r"|(?:能|会|可以)\s*(?:干|做|帮|处理)\s*(?:什么|啥|哪些)"
    r"|(?:有|包含)\s*(?:什么|啥|哪些)\s*(?:功能|作用|能力|本事)"
    r"|(?:的)?\s*(?:功能|作用|能力)\s*(?:都?有|是|包含)\s*(?:什么|啥|哪些)"
    r")\s*(?:呢|呀|啊|吗|嘛|捏|的)?\s*[?？]*\s*$"
)

FILE_FALLBACK_MB = 15  # 超过这个体积改用文件形式发送
CONFIG_RECHECK_SECONDS = 30.0  # 有人手工改 menu.json 时的兜底重载间隔


@register(PLUGIN_NAME, author="shskjw", desc="Web 可视化菜单编辑器", version="2.1.0")
class CustomMenuPlugin(Star):
    def __init__(self, context: Context, config: dict):
        super().__init__(context)
        self.cfg = config
        self._config: Optional[dict] = None
        self._config_mtime: int = -1
        self._config_checked_at: float = 0.0
        self._triggers: Dict[str, List[str]] = {}
        self._render_locks: Dict[str, asyncio.Lock] = {}
        self._ready = False
        self._error = ""

        self._natural_language = bool(config.get("enable_natural_language", True))
        self._file_fallback_mb = max(1, int(config.get("file_fallback_mb", FILE_FALLBACK_MB)))

    # ------------------------------------------------------------------ 生命周期

    async def initialize(self):
        """AstrBot 会 await 这个方法，初始化完成前不会有消息进来。"""
        try:
            import PIL  # noqa: F401
        except ImportError:
            self._error = "缺少 Pillow，请执行：pip install Pillow"
            logger.error(f"[{PLUGIN_NAME}] {self._error}")
            return

        try:
            await asyncio.to_thread(storage.plugin_storage.init_paths)
            await asyncio.to_thread(self.reload_config)
            webui.register(self)
            self._ready = True
            logger.info(f"[{PLUGIN_NAME}] 就绪，编辑面板见 WebUI 插件页「菜单编辑器」")
        except Exception as e:
            self._error = f"{e.__class__.__name__}: {e}"
            logger.error(f"[{PLUGIN_NAME}] 初始化失败: {traceback.format_exc()}")

    async def terminate(self):
        """插件被禁用或重载时调用。注意基类的钩子叫 terminate，不是 on_unload。"""
        self._render_locks.clear()
        self._config = None

    # ------------------------------------------------------------------ 配置

    def reload_config(self) -> dict:
        """强制重新读盘并重建触发词索引。WebUI 保存后会直接调用它。"""
        self._config = storage.plugin_storage.load_config()
        self._config_mtime = self._stat_mtime()
        self._config_checked_at = time.monotonic()

        index = collections.defaultdict(list)
        for menu in self._config.get("menus", []):
            menu_id = menu.get("id")
            if not menu_id or not menu.get("enabled", True):
                continue
            for word in re.split(r"[,，;；\s]+", menu.get("trigger_keywords") or ""):
                if word:
                    index[word].append(menu_id)
        self._triggers = dict(index)
        return self._config

    def _stat_mtime(self) -> int:
        try:
            return storage.plugin_storage.menu_file.stat().st_mtime_ns
        except OSError:
            return -1

    @property
    def config(self) -> dict:
        """带缓存的配置读取。命中缓存时完全不碰磁盘。"""
        if self._config is None:
            return self.reload_config()
        now = time.monotonic()
        if now - self._config_checked_at >= CONFIG_RECHECK_SECONDS:
            self._config_checked_at = now
            if self._stat_mtime() != self._config_mtime:
                return self.reload_config()
        return self._config

    # ------------------------------------------------------------------ 触发

    @filter.command(MENU_COMMAND, alias=MENU_ALIASES, priority=10)
    async def on_menu_command(self, event: AstrMessageEvent):
        """/菜单 及其别名。"""
        if not self._ready:
            await event.send(event.plain_result(f"❌ 菜单插件未就绪：{self._error}"))
            return
        await self._respond(event, self._default_menus())

    @filter.event_message_type(filter.EventMessageType.ALL, priority=-50)
    async def on_natural_language(self, event: AstrMessageEvent):
        """自定义触发词 + 自然语言兜底。

        priority 为负，排在所有普通 handler 之后执行，不会抢掉别人的指令；
        没命中时只查一次内存字典，不读盘也不解析 JSON。
        """
        if not self._ready:
            return
        msg = event.message_str.strip()
        if not msg:
            return

        menu_ids = self._triggers.get(msg)
        if menu_ids:
            await self._respond(event, self._menus_by_id(menu_ids))
        elif self._natural_language and NATURAL_LANGUAGE.match(msg):
            await self._respond(event, self._default_menus())

    @filter.command("开启后台", alias={"关闭后台"}, priority=10)
    async def on_legacy_web_command(self, event: AstrMessageEvent):
        """老版本靠独立端口开后台，现在面板在 WebUI 里。"""
        event.stop_event_propagation()
        await event.send(event.plain_result(
            "📌 菜单编辑面板已经搬进 AstrBot WebUI 了：\n"
            "  WebUI → 插件管理 → astrbot_plugin_custom_menu →「菜单编辑器」\n"
            "不用再开端口，也不用记密钥。"
        ))

    # ------------------------------------------------------------------ 菜单选取

    def _enabled_menus(self) -> List[dict]:
        return [m for m in self.config.get("menus", []) if m.get("enabled", True)]

    def _default_menus(self) -> List[dict]:
        """没配专属触发词的菜单，作为默认菜单。"""
        return [
            m for m in self._enabled_menus()
            if not (m.get("trigger_keywords") or "").strip()
        ]

    def _menus_by_id(self, ids: List[str]) -> List[dict]:
        wanted = set(ids)
        return [m for m in self._enabled_menus() if m.get("id") in wanted]

    # ------------------------------------------------------------------ 响应

    async def _respond(self, event: AstrMessageEvent, menus: List[dict]):
        if not menus:
            return
        event.stop_event_propagation()
        for menu in menus:
            try:
                path = await self.render_menu(menu)
            except Exception as e:
                logger.error(
                    f"[{PLUGIN_NAME}] 渲染「{menu.get('name')}」失败: {traceback.format_exc()}"
                )
                await event.send(event.plain_result(f"❌ 菜单「{menu.get('name')}」渲染失败：{e}"))
                continue
            await self._send_image(event, path)

    async def _send_image(self, event: AstrMessageEvent, path: Path):
        try:
            size_mb = path.stat().st_size / (1024 * 1024)
        except OSError:
            size_mb = 0.0

        if size_mb > self._file_fallback_mb:
            logger.info(f"[{PLUGIN_NAME}] 菜单 {size_mb:.1f}MB 超过阈值，改用文件发送")
            await self._send_as_file(event, path, f"⚠️ 菜单体积 {size_mb:.1f}MB，已改用文件发送。")
            return

        try:
            await event.send(event.image_result(str(path.resolve())))
        except Exception as e:
            logger.warning(f"[{PLUGIN_NAME}] 图片发送失败（{e}），改用文件发送")
            await self._send_as_file(event, path, "⚠️ 图片发送失败，已改用文件发送。")

    async def _send_as_file(self, event: AstrMessageEvent, path: Path, note: str):
        await event.send(event.chain_result([
            File(file=str(path.resolve()), name=path.name),
            Plain(f"\n{note}"),
        ]))

    # ------------------------------------------------------------------ 渲染

    async def render_menu(self, menu: dict) -> Path:
        """渲染并返回可发送的文件路径；命中缓存时直接返回。

        每个菜单一把锁，连发多次不会把同一张图重复渲染好几遍。
        """
        menu_id = menu.get("id") or "default"
        lock = self._render_locks.setdefault(menu_id, asyncio.Lock())
        async with lock:
            return await asyncio.to_thread(self._render_sync, menu)

    def _render_sync(self, menu: dict) -> Path:
        from .renderer.menu import render_animated, render_static

        store = storage.plugin_storage
        menu_id = menu.get("id")

        if menu.get("bg_type") == "video":
            fmt = menu.get("video_export_format", "apng")
            cache = store.get_menu_output_cache_path(menu_id, True, fmt)
            if cache.exists():
                return cache
            result = render_animated(menu, cache)
            if not result or not result.exists():
                raise RuntimeError("动态菜单渲染失败，请检查视频源以及 imageio-ffmpeg 是否安装")
            return result

        backgrounds = [b for b in (menu.get("backgrounds") or []) if b]
        if len(backgrounds) > 1:
            return self._render_random_bg(menu, backgrounds, render_static)

        cache = store.get_menu_output_cache_path(menu_id, False, "png")
        if not cache.exists():
            render_static(menu).save(cache)
        return cache

    def _render_random_bg(self, menu: dict, backgrounds: List[str], render_static) -> Path:
        """多背景菜单：每个背景各渲一次并缓存，之后每次随机挑一张发。"""
        store = storage.plugin_storage
        paths = []
        for index, bg in enumerate(backgrounds):
            cache = store.get_menu_output_cache_path(menu.get("id"), False, "png", bg_index=index)
            if not cache.exists():
                variant = dict(menu, background=bg, backgrounds=[])
                render_static(variant).save(cache)
                logger.info(f"[{PLUGIN_NAME}] 已缓存背景 {index + 1}/{len(backgrounds)}：{bg}")
            paths.append(cache)
        return random.choice(paths)

    # ------------------------------------------------------------------ 供 WebUI 调用

    def collect_commands(self) -> Dict[str, List[Dict[str, str]]]:
        """扫描其它插件注册的指令，供编辑器一键填充。"""
        try:
            stars = [s for s in self.context.get_all_stars() if getattr(s, "activated", True)]
        except Exception as e:
            logger.error(f"[{PLUGIN_NAME}] 获取插件列表失败：{e}")
            return {}

        by_module = collections.defaultdict(list)
        for handler in star_handlers_registry:
            if isinstance(handler, StarHandlerMetadata):
                by_module[handler.handler_module_path].append(handler)

        result: Dict[str, List[Dict[str, str]]] = collections.defaultdict(list)
        for star in stars:
            name = getattr(star, "name", "")
            module = getattr(star, "module_path", None)
            if not name or not module or name == PLUGIN_NAME:
                continue
            for handler in by_module.get(module, []):
                command = None
                for event_filter in handler.event_filters:
                    if isinstance(event_filter, CommandFilter):
                        command = event_filter.command_name
                        break
                    if isinstance(event_filter, CommandGroupFilter):
                        command = event_filter.group_name
                        break
                if not command:
                    continue
                item = {"cmd": command, "desc": handler.desc or ""}
                if item not in result[name]:
                    result[name].append(item)
        return dict(result)
