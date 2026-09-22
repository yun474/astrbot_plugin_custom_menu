"""菜单配置与素材的落盘位置。"""

import json
import shutil
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from astrbot.api import logger
from astrbot.api.star import StarTools

PLUGIN_NAME = "astrbot_plugin_custom_menu"
DEFAULT_MENU_ID = "menu_default"
CONFIG_VERSION = 16


class PluginStorage:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        self.base_dir = Path(__file__).parent
        self.data_dir: Optional[Path] = None
        self.assets_dir: Optional[Path] = None
        self.bg_dir: Optional[Path] = None
        self.icon_dir: Optional[Path] = None
        self.img_dir: Optional[Path] = None
        self.video_dir: Optional[Path] = None
        self.fonts_dir: Optional[Path] = None
        self.outputs_dir: Optional[Path] = None
        self.menu_file: Optional[Path] = None
        self._initialized = True

    # ------------------------------------------------------------------ 路径

    def init_paths(self):
        self.data_dir = Path(StarTools.get_data_dir(PLUGIN_NAME))
        self.assets_dir = self.data_dir / "assets"
        self.bg_dir = self.assets_dir / "backgrounds"
        self.icon_dir = self.assets_dir / "icons"
        self.img_dir = self.assets_dir / "widgets"
        self.video_dir = self.assets_dir / "videos"
        self.fonts_dir = self.assets_dir / "fonts"
        self.outputs_dir = self.data_dir / "outputs"
        self.menu_file = self.data_dir / "menu.json"

        # 迁移必须赶在建目录之前：老版本判断的是"新目录不存在"，
        # 而那时目录早就被建出来了，于是迁移永远不会发生。
        self._migrate_legacy_data()
        self._init_directories()
        self._seed_builtin_fonts()

    def _migrate_legacy_data(self):
        """把插件目录下的老 data/ 搬到 AstrBot 的插件数据目录。"""
        legacy = self.base_dir / "data"
        if not legacy.is_dir():
            return
        try:
            if legacy.resolve() == self.data_dir.resolve():
                return
        except OSError:
            return
        if self.menu_file.exists():
            return  # 新位置已经有数据，不覆盖

        try:
            shutil.copytree(legacy, self.data_dir, dirs_exist_ok=True)
            logger.info(f"[{PLUGIN_NAME}] 已把旧数据从 {legacy} 迁移到 {self.data_dir}")
        except OSError as e:
            logger.warning(f"[{PLUGIN_NAME}] 旧数据迁移失败：{e}")

    def _init_directories(self):
        for path in (
            self.data_dir,
            self.assets_dir,
            self.bg_dir,
            self.icon_dir,
            self.img_dir,
            self.video_dir,
            self.fonts_dir,
            self.outputs_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)

    def _seed_builtin_fonts(self):
        """把插件自带的 title.ttf / text.ttf 铺到素材目录。"""
        source = self.base_dir / "fonts"
        if not source.is_dir():
            return
        for font in source.glob("*.*"):
            target = self.fonts_dir / font.name
            if target.exists():
                continue
            try:
                shutil.copy(font, target)
            except OSError as e:
                logger.warning(f"[{PLUGIN_NAME}] 内置字体 {font.name} 复制失败：{e}")

    # ------------------------------------------------------------------ 配置

    def load_config(self) -> Dict[str, Any]:
        if self.menu_file and self.menu_file.exists():
            try:
                return json.loads(self.menu_file.read_text(encoding="utf-8"))
            except (OSError, ValueError) as e:
                # 不要覆盖损坏的文件，留给用户自己抢救
                logger.error(f"[{PLUGIN_NAME}] menu.json 读取失败，暂用默认配置：{e}")
                return self._default_config()

        default = self._default_config()
        if self.menu_file:
            self.save_config(default)
        return default

    def save_config(self, data: Dict[str, Any]):
        if not self.menu_file:
            return
        # 先写临时文件再替换，避免写一半崩了把配置写坏
        tmp = self.menu_file.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.menu_file)

    def _default_config(self) -> Dict[str, Any]:
        return {"version": CONFIG_VERSION, "menus": [self.create_default_menu()]}

    def create_default_menu(self, name: str = "默认菜单", menu_id: str = "") -> Dict[str, Any]:
        return {
            "id": menu_id or DEFAULT_MENU_ID,
            "enabled": True,
            "name": name,
            "trigger_keywords": "",
            "title": "功能菜单",
            "sub_title": "System Menu",
            "title_align": "center",
            "use_canvas_size": False,
            "canvas_width": 1000,
            "canvas_height": 2000,
            "canvas_color": "#1e1e1e",
            "export_scale": 1.0,
            "bg_type": "image",
            "bg_video": "",
            "video_start": 0.0,
            "video_end": 0.0,
            "video_fps_mode": "fixed",
            "video_fps": 15,
            "video_frame_ratio": 1,
            "video_scale": 1.0,
            "video_export_format": "apng",
            "background": "",
            "backgrounds": [],
            "bg_fit_mode": "cover_w",
            "bg_custom_width": 1000,
            "bg_custom_height": 1000,
            "bg_align_x": "center",
            "bg_align_y": "top",
            "group_bg_color": "#000000",
            "group_bg_alpha": 50,
            "group_blur_radius": 0,
            "item_bg_color": "#FFFFFF",
            "item_bg_alpha": 20,
            "item_blur_radius": 0,
            "layout_columns": 3,
            "title_color": "#FFFFFF",
            "subtitle_color": "#DDDDDD",
            "group_title_color": "#FFFFFF",
            "group_sub_color": "#AAAAAA",
            "item_name_color": "#FFFFFF",
            "item_desc_color": "#AAAAAA",
            "title_font": "title.ttf",
            "group_title_font": "text.ttf",
            "group_sub_font": "text.ttf",
            "group_sub_align": "bottom",
            "item_name_font": "title.ttf",
            "item_desc_font": "text.ttf",
            "shadow_enabled": False,
            "shadow_color": "#000000",
            "shadow_offset_x": 2,
            "shadow_offset_y": 2,
            "shadow_radius": 2,
            "title_size": 60,
            "group_title_size": 30,
            "group_sub_size": 18,
            "item_name_size": 26,
            "item_desc_size": 16,
            "custom_widgets": [],
            "groups": [
                {
                    "title": "常用指令",
                    "subtitle": "Basic",
                    "free_mode": False,
                    "min_height": 0,
                    "items": [
                        {"name": "帮助", "desc": "查看说明", "icon": "", "x": 20, "y": 60, "w": 280, "h": 100},
                        {"name": "状态", "desc": "系统状态", "icon": "", "x": 320, "y": 60, "w": 280, "h": 100},
                    ],
                }
            ],
        }

    # ------------------------------------------------------------------ 素材

    def get_assets_list(self) -> Dict[str, list]:
        def scan(path: Optional[Path], exts: tuple) -> list:
            if not path or not path.is_dir():
                return []
            return sorted(f.name for f in path.glob("*") if f.suffix.lower() in exts)

        return {
            "backgrounds": scan(self.bg_dir, (".png", ".jpg", ".jpeg", ".webp")),
            "icons": scan(self.icon_dir, (".png", ".jpg", ".jpeg", ".webp")),
            "widget_imgs": scan(self.img_dir, (".png", ".jpg", ".jpeg", ".gif", ".webp")),
            "fonts": scan(self.fonts_dir, (".ttf", ".otf", ".ttc")),
            "videos": scan(self.video_dir, (".mp4", ".mov", ".webm", ".avi", ".mkv")),
        }

    # ------------------------------------------------------------------ 出图缓存

    def get_menu_output_cache_path(
        self, menu_id: str, is_video: bool, output_format: str = "png", bg_index: int = None
    ) -> Path:
        if not self.outputs_dir:
            self.init_paths()

        ext = "png"
        if is_video:
            ext = {"webp": "webp", "gif": "gif"}.get((output_format or "").lower(), "png")

        suffix = f"_bg{bg_index}" if bg_index is not None else ""
        return self.outputs_dir / f"menu_{menu_id}{suffix}.{ext}"

    def clear_menu_cache(self, menu_id: str):
        if not self.outputs_dir or not menu_id:
            return
        for path in self.outputs_dir.glob(f"menu_{menu_id}*"):
            try:
                path.unlink()
            except OSError:
                pass

    def cleanup_unused_caches(self, current_menus: List[Dict]):
        """删掉已经不存在的菜单留下的缓存。"""
        if not self.outputs_dir or not self.outputs_dir.is_dir():
            return

        alive = {m.get("id") for m in current_menus if m.get("id")}
        for path in self.outputs_dir.glob("menu_*.*"):
            menu_id = path.stem[len("menu_"):].split("_bg")[0]
            if menu_id and menu_id not in alive:
                try:
                    path.unlink()
                except OSError:
                    pass


plugin_storage = PluginStorage()
