const STALE_DATA_MINUTES = 45;
const MAX_RETENTION_HOURS = 24;
const SPEED_FRESH_MINUTES = 15;
const MIN_DISPLAY_AGE_MINUTES = 1;

const MIN_MOVEMENT_METERS = 150;
const MOVING_MIN_DISTANCE_METERS = 300;
const MOVING_MIN_SPEED_KMH = 5;

const WEBHOOK_DELAY_MS = 1500;
const COORD_DECIMALS = 5;

const MAP_HEADERS = {
  "User-Agent": "AutomationLocationTracker/1.0",
  "Accept": "application/json"
};

function readJsonState(context, prefix, key, fallback) {
  const raw = context.state.get(prefix, key);
  if (raw == null || raw === "") {
    return fallback;
  }
  if (typeof raw === "object") {
    return raw;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed !== null && typeof parsed === "object" ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function writeJsonState(context, prefix, key, value) {
  context.state.set(prefix, key, value === null ? "" : JSON.stringify(value));
}

function readTrackedUsers(context) {
  const raw = context.state.get("TRACKED", "USERS");
  if (Array.isArray(raw)) {
    return raw.filter(Boolean);
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
      } catch {
        return [];
      }
    }
    return trimmed.split(",").map(s => s.trim()).filter(Boolean);
  }
  return [];
}

function computeDistanceMeters(lat1, lng1, lat2, lng2) {
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatFrenchDateTime(date) {
  const weekday = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    weekday: "long"
  }).format(date);
  const capitalizedDay = weekday.charAt(0).toUpperCase() + weekday.slice(1);

  const dayMonth = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "2-digit"
  }).format(date);

  return `${capitalizedDay} ${dayMonth} à ${formatHHMM(date)}`;
}

function formatHHMM(date) {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const hour = parts.find(p => p.type === "hour")?.value || "00";
  const minute = parts.find(p => p.type === "minute")?.value || "00";
  return `${hour}h${minute}`;
}

function formatDuration(totalMinutes) {
  const mins = Math.max(0, Math.round(totalMinutes));
  return mins < 60
    ? `${mins} min`
    : `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}`;
}

function formatDrivingDuration(seconds) {
  const totalMinutes = Math.max(1, Math.round(seconds / 60));
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins > 0 ? `${hours} h ${String(mins).padStart(2, "0")}` : `${hours} h`;
}

function formatFrenchDistance(meters) {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(1).replace(".", ",")} km`;
}

function formatNominatimAddress(data, lat, lng) {
  const addr = data?.address;
  if (!addr) {
    return data?.display_name
      ? data.display_name.replace(/, France$/i, "")
      : `${lat.toFixed(COORD_DECIMALS)}, ${lng.toFixed(COORD_DECIMALS)}`;
  }

  const street = [addr.house_number, addr.road || addr.pedestrian || addr.path]
    .filter(Boolean)
    .join(" ");
  const city = addr.city || addr.town || addr.village || addr.municipality || "";
  const cityLine = [addr.postcode, city].filter(Boolean).join(" ");

  const parts = [street, cityLine].filter(Boolean);
  return parts.length > 0
    ? parts.join(", ")
    : `${lat.toFixed(COORD_DECIMALS)}, ${lng.toFixed(COORD_DECIMALS)}`;
}

async function resolveHomeCoords(context, homeAddress) {
  if (!homeAddress) {
    return null;
  }

  const cached = readJsonState(context, "HOME", "COORDS", null);
  if (cached && cached.address === homeAddress && cached.lat != null && cached.lng != null) {
    return cached;
  }

  try {
    const query = encodeURIComponent(homeAddress);
    const results = await context.gateway.getJson(
      `/nominatim/search?format=jsonv2&limit=1&q=${query}`,
      MAP_HEADERS
    );
    if (Array.isArray(results) && results[0]?.lat && results[0]?.lon) {
      const coords = {
        address: homeAddress,
        lat: parseFloat(results[0].lat),
        lng: parseFloat(results[0].lon)
      };
      writeJsonState(context, "HOME", "COORDS", coords);
      return coords;
    }
  } catch (e) {
    console.warn(`[LocationTracker] Failed to geocode home address (${e.message}).`);
  }

  return null;
}

async function getLocationContext(context, lat, lng, now, homeLabel, homeAddress) {
  let address = `${lat.toFixed(COORD_DECIMALS)}, ${lng.toFixed(COORD_DECIMALS)}`;
  let city = "";

  try {
    const geo = await context.gateway.getJson(
      `/nominatim/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=fr`,
      MAP_HEADERS
    );
    if (geo) {
      address = formatNominatimAddress(geo, lat, lng);
      const addr = geo.address || {};
      city = addr.city || addr.town || addr.village || addr.municipality || addr.county || "";
    }
  } catch (e) {
    console.warn(`[LocationTracker] Reverse geocoding failed (${e.message}).`);
  }

  let etaHomeText = null;
  if (homeLabel && homeAddress && city.toLowerCase() !== homeLabel.toLowerCase()) {
    const homeCoords = await resolveHomeCoords(context, homeAddress);
    if (homeCoords) {
      try {
        const routeData = await context.gateway.getJson(
          `/osrm/route/v1/driving/${lng},${lat};${homeCoords.lng},${homeCoords.lat}?overview=false`,
          MAP_HEADERS
        );
        const leg = routeData?.routes?.[0];
        if (leg?.distance != null && leg?.duration != null) {
          const arrival = new Date(now.getTime() + leg.duration * 1000);
          etaHomeText = `${formatFrenchDistance(leg.distance)} · ${formatDrivingDuration(leg.duration)} en voiture (arrivée vers ${formatHHMM(arrival)})`;
        }
      } catch (e) {
        console.warn(`[LocationTracker] OSRM route lookup failed (${e.message}).`);
      }
    }
  }

  return { address, city, etaHomeText };
}

async function sendDiscordEmbed(context, embed) {
  const webhookId = context.secrets.DISCORD_LOCATION_WEBHOOK_ID;
  const webhookToken = context.secrets.DISCORD_LOCATION_WEBHOOK_TOKEN;
  if (!webhookId || !webhookToken) {
    throw new Error('Missing required secrets "DISCORD_LOCATION_WEBHOOK_ID" or "DISCORD_LOCATION_WEBHOOK_TOKEN".');
  }

  await context.gateway.postJson(
    `/discord/api/v10/webhooks/${webhookId}/${webhookToken}`,
    { embeds: [embed] }
  );
}

module.exports = async function (context) {
  const now = new Date();
  const homeLabel = String(context.secrets.HOME_LABEL || "").trim();
  const homeAddress = String(context.secrets.HOME_ADDRESS || "").trim();
  const trackedUsers = readTrackedUsers(context);

  if (trackedUsers.length === 0) {
    return;
  }

  const activeUsers = [];
  let usersChanged = false;

  for (let i = 0; i < trackedUsers.length; i++) {
    const key = trackedUsers[i];
    const ping = readJsonState(context, "PING", key, null);

    if (!ping || !ping.updatedAt) {
      usersChanged = true;
      continue;
    }

    const ageHours = (now - new Date(ping.updatedAt)) / 3600000;
    if (ageHours > MAX_RETENTION_HOURS) {
      writeJsonState(context, "PING", key, null);
      writeJsonState(context, "SENT", key, null);
      usersChanged = true;
      continue;
    }

    activeUsers.push(key);

    const prevSent = readJsonState(context, "SENT", key, {});
    const recordedAt = new Date(ping.updatedAt);
    const ageMinutes = Math.max(0, Math.round((now - recordedAt) / 60000));
    const isStale = ageMinutes > STALE_DATA_MINUTES;

    const hasPreviousMessage = prevSent.lastSentLat != null && prevSent.lastSentLng != null;
    const movedFromLastMsg = hasPreviousMessage
      ? Math.round(computeDistanceMeters(prevSent.lastSentLat, prevSent.lastSentLng, ping.lat, ping.lng))
      : null;

    const noNewPingSinceLastSend =
      prevSent.lastSentAt && new Date(ping.updatedAt) <= new Date(prevSent.lastSentAt);
    const hasNotMoved = hasPreviousMessage && movedFromLastMsg < MIN_MOVEMENT_METERS;
    const isRecoveredFromStale = !isStale && !noNewPingSinceLastSend && Boolean(prevSent.lastSentWasStale);

    if (noNewPingSinceLastSend) {
      if (!isStale || prevSent.lastSentWasStale) {
        console.log(`[LocationTracker] ${ping.name}: Aucun nouveau relevé, envoi Discord ignoré.`);
        continue;
      }
    } else if (hasNotMoved && !isRecoveredFromStale) {
      if (!isStale || prevSent.lastSentWasStale) {
        console.log(`[LocationTracker] ${ping.name}: Position inchangée (${movedFromLastMsg ?? 0} m), envoi Discord ignoré.`);
        continue;
      }
    }

    const info = await getLocationContext(context, ping.lat, ping.lng, now, homeLabel, homeAddress);

    const isSpeedFresh = ageMinutes <= SPEED_FRESH_MINUTES;
    const speedKmh =
      isSpeedFresh && ping.speedMs != null && !Number.isNaN(ping.speedMs) && ping.speedMs >= 0
        ? Math.round(ping.speedMs * 3.6)
        : null;

    const isMoving =
      speedKmh !== null
        ? speedKmh >= MOVING_MIN_SPEED_KMH
        : movedFromLastMsg !== null && movedFromLastMsg >= MOVING_MIN_DISTANCE_METERS;

    let statusTitle;
    let embedColor;
    if (isStale) {
      statusTitle = `Position non actualisée (il y a ${formatDuration(ageMinutes)})`;
      embedColor = 14251782;
    } else if (isMoving) {
      statusTitle = `En déplacement · ${info.city || "Position GPS"}`;
      embedColor = 3447003;
    } else {
      statusTitle = info.city ? `À ${info.city}` : "Position actuelle";
      embedColor = 1981066;
    }

    const mapsUrl = `https://www.google.com/maps?q=${ping.lat},${ping.lng}`;
    const wazeUrl = `https://waze.com/ul?ll=${ping.lat},${ping.lng}&navigate=yes`;
    const precisionText = ping.accuracy != null ? ` (±${ping.accuracy} m)` : "";

    const lines = [
      `**Adresse :** ${info.address}${precisionText}`,
      `**Carte :** [Google Maps](${mapsUrl}) · [Waze](${wazeUrl})`
    ];

    const movementParts = [];
    if (speedKmh !== null) {
      movementParts.push(speedKmh < MOVING_MIN_SPEED_KMH ? "Immobile" : `${speedKmh} km/h`);
    } else {
      movementParts.push(isMoving ? "En mouvement" : "Sur place");
    }

    if (movedFromLastMsg !== null && movedFromLastMsg > 0) {
      const distStr =
        movedFromLastMsg >= 1000
          ? `${(movedFromLastMsg / 1000).toFixed(1)} km`
          : `${movedFromLastMsg} m`;
      const sinceTime = prevSent.lastSentAt ? ` (${formatHHMM(new Date(prevSent.lastSentAt))})` : "";
      movementParts.push(`+${distStr} depuis dernier message${sinceTime}`);
    }
    lines.push(`**Déplacement :** ${movementParts.join(" · ")}`);

    if (info.etaHomeText && homeLabel) {
      lines.push(`**Retour ${homeLabel} :** ${info.etaHomeText}`);
    }

    const phoneParts = [
      `${formatHHMM(recordedAt)}${ageMinutes > MIN_DISPLAY_AGE_MINUTES ? ` (il y a ${formatDuration(ageMinutes)})` : ""}`
    ];
    if (ping.battery != null && !Number.isNaN(ping.battery)) {
      phoneParts.push(`Batterie ${ping.battery}%${ping.charging ? " (en charge)" : ""}`);
    }
    lines.push(`**Dernier relevé :** ${phoneParts.join(" · ")}`);

    await sendDiscordEmbed(context, {
      title: `${ping.name} · ${statusTitle} · ${formatFrenchDateTime(now)}`,
      description: lines.join("\n"),
      color: embedColor,
      timestamp: now.toISOString()
    });

    writeJsonState(context, "SENT", key, {
      lastSentLat: ping.lat,
      lastSentLng: ping.lng,
      lastSentAt: now.toISOString(),
      lastSentWasStale: isStale
    });

    console.log(`[LocationTracker] Sent Discord embed for ${ping.name}.`);

    if (i < trackedUsers.length - 1) {
      await context.sleep(WEBHOOK_DELAY_MS);
    }
  }

  if (usersChanged) {
    writeJsonState(context, "TRACKED", "USERS", activeUsers);
  }
};
