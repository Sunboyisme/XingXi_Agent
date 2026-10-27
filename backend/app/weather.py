"""Open-Meteo adapter; no provider key is needed for personal use."""

from datetime import datetime, timezone

from httpx import AsyncClient

GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
CONDITIONS = {
    0: "晴",
    1: "大部晴朗",
    2: "局部多云",
    3: "阴",
    45: "雾",
    48: "雾凇",
    51: "小毛毛雨",
    53: "毛毛雨",
    55: "强毛毛雨",
    56: "冻毛毛雨",
    57: "强冻毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    66: "冻雨",
    67: "强冻雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    77: "雪粒",
    80: "小阵雨",
    81: "阵雨",
    82: "强阵雨",
    85: "阵雪",
    86: "强阵雪",
    95: "雷暴",
    96: "雷暴伴小冰雹",
    99: "雷暴伴大冰雹",
}


def location_read(item: dict) -> dict:
    return {
        key: item.get(key)
        for key in (
            "id",
            "name",
            "admin1",
            "admin2",
            "admin3",
            "country",
            "country_code",
            "latitude",
            "longitude",
        )
    }


async def get_weather(
    city: str, days: int = 3, country_code: str = "", location_id: int | None = None,
    *, selected_location: dict | None = None,
) -> dict:
    if not city.strip() or len(city) > 120 or not 1 <= days <= 7:
        raise ValueError("请提供城市名称；预报天数为 1 到 7 天。")
    if country_code and (len(country_code) != 2 or not country_code.isalpha()):
        raise ValueError("国家代码应为两个英文字母，例如 CN。")
    params = {"name": city.strip(), "count": 10, "language": "zh", "format": "json"}
    if country_code:
        params["countryCode"] = country_code.upper()
    async with AsyncClient(timeout=20) as client:
        if selected_location is not None:
            location = selected_location
        else:
            response = await client.get(GEOCODING_URL, params=params)
            response.raise_for_status()
            locations = response.json().get("results", [])
            if not locations:
                return {
                    "error": "未找到城市，请补充省份、国家或使用拼音/英文城市名。",
                    "query": city,
                }
            if location_id is not None:
                location = next(
                    (item for item in locations if item["id"] == location_id), None
                )
                if not location:
                    return {"error": "所选地点不在本次查询结果中，请重新查询城市。"}
            elif len(locations) > 1:
                return {
                    "needs_clarification": True,
                    "message": "找到多个地点，请让用户确认省份或国家，再用对应 location_id 查询。",
                    "locations": [location_read(item) for item in locations],
                }
            else:
                location = locations[0]
        response = await client.get(
            FORECAST_URL,
            params={
                "latitude": location["latitude"],
                "longitude": location["longitude"],
                "current": "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
                "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
                "timezone": "auto",
                "forecast_days": days,
                "temperature_unit": "celsius",
                "wind_speed_unit": "kmh",
            },
        )
        response.raise_for_status()
        data = response.json()
    current, daily = data.get("current", {}), data.get("daily", {})
    if current.get("temperature_2m") is None or not daily.get("time"):
        return {"error": "天气服务未返回完整数据，请稍后重试。"}
    forecast = []
    for index, date in enumerate(daily["time"]):

        def at(key, index=index):
            values = daily.get(key, [])
            return values[index] if index < len(values) else None

        forecast.append(
            {
                "date": date,
                "condition": CONDITIONS.get(at("weather_code"), "未知"),
                "temperature_max_c": at("temperature_2m_max"),
                "temperature_min_c": at("temperature_2m_min"),
                "precipitation_probability_percent": at(
                    "precipitation_probability_max"
                ),
            }
        )
    return {
        "location": location_read(location),
        "timezone": data.get("timezone"),
        "utc_offset_seconds": data.get("utc_offset_seconds"),
        "current": {
            "time": current.get("time"),
            "condition": CONDITIONS.get(current.get("weather_code"), "未知"),
            "temperature_c": current["temperature_2m"],
            "apparent_temperature_c": current.get("apparent_temperature"),
            "humidity_percent": current.get("relative_humidity_2m"),
            "wind_speed_kmh": current.get("wind_speed_10m"),
        },
        "forecast": forecast,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "source": {
            "name": "Open-Meteo",
            "url": "https://open-meteo.com/",
            "data_url": str(response.url),
        },
        "note": "当前天气与预报来自气象模型；时间按查询地点的时区显示。",
    }


def previous_location(run_id, conversation_id, city, location_id, country_code=""):
    """Reuse a real earlier-turn candidate instead of re-geocoding a changed list."""
    if location_id is None:
        return None
    from sqlalchemy import select
    from .config import PROFILE_ID
    from .db import Run, RunEvent, Session
    from .task_context import user_message
    with Session() as db:
        source = user_message(db, run_id, conversation_id)
        if not source:
            return None
        for event in db.scalars(select(RunEvent).join(Run, Run.id == RunEvent.run_id).where(
            Run.conversation_id == conversation_id, Run.profile_id == PROFILE_ID,
            Run.source_message_id != source.id, RunEvent.kind == "tool").order_by(RunEvent.id.desc())):
            data = event.data
            if data.get("tool_id") != "get_weather" or data.get("status") != "completed":
                continue
            result = data.get("result", {})
            if not isinstance(result, dict):
                continue
            locations = result.get("locations", []) + ([result["location"]] if result.get("location") else [])
            for location in locations:
                if location.get("id") == location_id and (not country_code or location.get("country_code") == country_code.upper()) and city in {data.get("arguments", {}).get("city"), location.get("name")}:
                    return location_read(location)
    return None
