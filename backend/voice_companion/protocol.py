from __future__ import annotations

import math
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt


DEVICE_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
RECORDING_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
SAMPLE_RATE = 16000
PCM_BYTES_PER_MS = 32
MAX_FRAME_BYTES = 6400
VAD_FRAME_BYTES = 3200


class DisplaySettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    font_scale: StrictInt = Field(default=1, ge=1, le=4)
    display_mode: Literal["page", "scroll", "typewriter", "static"] = "page"
    page_ms: StrictInt = Field(default=2500, ge=500, le=10000)
    scroll_speed: StrictInt = Field(default=20, ge=5, le=60)
    brightness: StrictInt = Field(default=160, ge=1, le=255)
    animation: StrictBool = True


def validated_settings(patch: object, current: dict | None = None) -> dict:
    if not isinstance(patch, dict) or not patch:
        raise ValueError("显示设置必须是非空对象")
    return DisplaySettings.model_validate({**(current or {}), **patch}).model_dump()


def valid_level(value: object) -> bool:
    return not isinstance(value, bool) and isinstance(value, (float, int)) and math.isfinite(value) and 0 <= value <= 1


def error_event(code: str, message: str, **fields: object) -> dict:
    return {"type": "error", "code": code, "message": message, **fields}
