import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ---------- WMO weather code -> description ----------
const WEATHER_CODES: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Light rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Light snow",
  73: "Moderate snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Light rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Light snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

const describeWeather = (code: number) => WEATHER_CODES[code] ?? `Unknown (code ${code})`;

// US AQI categories
function describeUsAqi(aqi: number) {
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for sensitive groups";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very unhealthy";
  return "Hazardous";
}

// ---------- Units ----------
const unitsSchema = z
  .enum(["metric", "imperial"])
  .default("metric")
  .describe("metric (°C, km/h, mm) or imperial (°F, mph, inch)");

type Units = z.infer<typeof unitsSchema>;

function unitParams(units: Units) {
  return units === "imperial"
    ? "&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch"
    : "&temperature_unit=celsius&wind_speed_unit=kmh&precipitation_unit=mm";
}

// ---------- Helpers ----------
type Place = { name: string; country: string; lat: number; lon: number };

async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error ${res.status} for ${new URL(url).hostname}`);
  return res.json();
}

async function geocode(city: string): Promise<Place | null> {
  const data = await getJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`
  );
  const hit = data.results?.[0];
  return hit ? { name: hit.name, country: hit.country, lat: hit.latitude, lon: hit.longitude } : null;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

// Wraps a handler so any thrown error becomes a clean MCP tool error
function safe<A>(name: string, fn: (args: A) => Promise<ReturnType<typeof ok>>) {
  return async (args: A) => {
    console.error(`[${new Date().toISOString()}] ${name} called`, JSON.stringify(args));
    try {
      return await fn(args);
    } catch (err) {
      console.error(`${name} failed:`, err);
      return fail(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

// ---------- Server factory ----------
export function createServer() {
  const server = new McpServer({ name: "weather", version: "2.0.0" });

  server.registerTool(
    "get_current_weather",
    {
      title: "Current Weather",
      description: "Get current weather conditions for a city",
      inputSchema: {
        city: z.string().describe("City name, e.g. Mumbai"),
        units: unitsSchema,
      },
    },
    safe("get_current_weather", async ({ city, units }: { city: string; units: Units }) => {
      const place = await geocode(city);
      if (!place) return fail(`Couldn't find "${city}".`);

      const data = await getJson(
        `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
          `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code${unitParams(units)}`
      );
      const c = data.current;
      const u = data.current_units;
      return ok(
        `Weather in ${place.name}, ${place.country}:\n` +
          `Conditions: ${describeWeather(c.weather_code)}\n` +
          `Temperature: ${c.temperature_2m}${u.temperature_2m}\n` +
          `Humidity: ${c.relative_humidity_2m}${u.relative_humidity_2m}\n` +
          `Wind: ${c.wind_speed_10m} ${u.wind_speed_10m}`
      );
    })
  );

  server.registerTool(
    "get_forecast",
    {
      title: "Weather Forecast",
      description: "Get a daily forecast for a city (1-7 days)",
      inputSchema: {
        city: z.string().describe("City name"),
        days: z.number().int().min(1).max(7).default(3),
        units: unitsSchema,
      },
    },
    safe(
      "get_forecast",
      async ({ city, days, units }: { city: string; days: number; units: Units }) => {
        const place = await geocode(city);
        if (!place) return fail(`Couldn't find "${city}".`);

        const data = await getJson(
          `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
            `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum` +
            `&forecast_days=${days}&timezone=auto${unitParams(units)}`
        );
        const d = data.daily;
        const u = data.daily_units;
        const lines = d.time.map(
          (date: string, i: number) =>
            `${date}: ${describeWeather(d.weather_code[i])}, ` +
            `${d.temperature_2m_min[i]}${u.temperature_2m_min} to ${d.temperature_2m_max[i]}${u.temperature_2m_max}, ` +
            `precipitation ${d.precipitation_sum[i]} ${u.precipitation_sum}`
        );
        return ok(`Forecast for ${place.name}, ${place.country}:\n${lines.join("\n")}`);
      }
    )
  );

  server.registerTool(
    "get_air_quality",
    {
      title: "Air Quality",
      description: "Get current air quality (AQI and pollutant levels) for a city",
      inputSchema: { city: z.string().describe("City name, e.g. Delhi") },
    },
    safe("get_air_quality", async ({ city }: { city: string }) => {
      const place = await geocode(city);
      if (!place) return fail(`Couldn't find "${city}".`);

      const data = await getJson(
        `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${place.lat}&longitude=${place.lon}` +
          `&current=us_aqi,european_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,ozone,sulphur_dioxide`
      );
      const c = data.current;
      const u = data.current_units;
      return ok(
        `Air quality in ${place.name}, ${place.country}:\n` +
          `US AQI: ${c.us_aqi} (${describeUsAqi(c.us_aqi)})\n` +
          `European AQI: ${c.european_aqi}\n` +
          `PM2.5: ${c.pm2_5} ${u.pm2_5}\n` +
          `PM10: ${c.pm10} ${u.pm10}\n` +
          `Ozone: ${c.ozone} ${u.ozone}\n` +
          `Nitrogen dioxide: ${c.nitrogen_dioxide} ${u.nitrogen_dioxide}\n` +
          `Sulphur dioxide: ${c.sulphur_dioxide} ${u.sulphur_dioxide}\n` +
          `Carbon monoxide: ${c.carbon_monoxide} ${u.carbon_monoxide}`
      );
    })
  );

  return server;
}