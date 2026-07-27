import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = path.join(ROOT, "data", "state.json");
const SITE_DATA_PATH = path.join(ROOT, "site", "data.js");
const FUND_SENDER = "Auto-Disclosure@citics.com";

const readJson = async file => JSON.parse(await fs.readFile(file, "utf8"));
const compactDate = date => date.replaceAll("-", "");
const axisLabel = date => date.slice(5);
const round = (value, digits = 8) => Number(value.toFixed(digits));

function shanghaiToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shanghaiNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

function normalizeDate(year, month, day) {
  const value = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day)
  ) {
    return null;
  }
  return value;
}

function findValuationDate(text) {
  const keywordPatterns = [
    /(?:估值日期|净值日期|产品净值日期|业务日期|数据日期|净值日)\s*[：:=]?\s*(20\d{2})\D{0,3}(\d{1,2})\D{0,3}(\d{1,2})/i,
    /(?:估值日期|净值日期|产品净值日期|业务日期|数据日期|净值日)\s*[：:=]?\s*(20\d{2})(\d{2})(\d{2})/i
  ];
  for (const pattern of keywordPatterns) {
    const match = text.match(pattern);
    if (match) return normalizeDate(match[1], match[2], match[3]);
  }

  const compact = text.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
  if (compact) return normalizeDate(compact[1], compact[2], compact[3]);

  const generic = text.match(/\b(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})日?\b/);
  return generic ? normalizeDate(generic[1], generic[2], generic[3]) : null;
}

function findUnitNav(text, valuationDate) {
  const patterns = [
    /(?:基金单位净值|产品单位净值|单位净值|单位\s*NAV)\s*(?:为|是|[：:=])?\s*([0-9]+\.[0-9]{3,8})/ig,
    /(?:基金净值|产品净值)\s*(?:为|是|[：:=])\s*([0-9]+\.[0-9]{3,8})/ig
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = Number(match[1]);
      if (value > 0.5 && value < 3) return value;
    }
  }

  const dateVariants = [
    valuationDate,
    valuationDate.replaceAll("-", ""),
    `${valuationDate.slice(0, 4)}年${Number(valuationDate.slice(5, 7))}月${Number(valuationDate.slice(8, 10))}日`
  ];
  for (const dateText of dateVariants) {
    let offset = text.indexOf(dateText);
    while (offset >= 0) {
      const nearby = text.slice(offset + dateText.length, offset + dateText.length + 240);
      const match = nearby.match(/\b([0-9]+\.[0-9]{3,8})\b/);
      if (match) {
        const value = Number(match[1]);
        if (value > 0.5 && value < 3) return value;
      }
      offset = text.indexOf(dateText, offset + dateText.length);
    }
  }
  return null;
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ");
}

async function fetchFundNavs() {
  const user = process.env.QQ_EMAIL;
  const pass = process.env.QQ_AUTH_CODE;
  if (!user || !pass) {
    throw new Error("QQ mailbox credentials are not configured");
  }

  const client = new ImapFlow({
    host: "imap.qq.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
    tls: { servername: "imap.qq.com" }
  });

  const parsedByDate = new Map();
  let candidateMessages = 0;
  let senderMessages = 0;
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search(
        { since: new Date("2026-06-25T00:00:00+08:00") },
        { uid: true }
      );
      if (!uids.length) return {};

      for await (const message of client.fetch(
        uids,
        { uid: true, source: true, internalDate: true },
        { uid: true }
      )) {
        candidateMessages += 1;
        const mail = await simpleParser(message.source);
        const fromTarget = (mail.from?.value || []).some(
          sender => sender.address?.toLowerCase() === FUND_SENDER.toLowerCase()
        );
        if (!fromTarget) continue;
        senderMessages += 1;
        const searchable = [
          mail.subject || "",
          mail.text || "",
          htmlToText(mail.html)
        ].join("\n");
        const date = findValuationDate(searchable);
        const nav = date ? findUnitNav(searchable, date) : null;
        if (!date || nav === null) {
          if (process.env.DEBUG_MAIL === "1") {
            console.log(JSON.stringify({
              subject: mail.subject || "",
              date,
              nav,
              excerpt: searchable.replace(/\s+/g, " ").slice(0, 800)
            }));
          }
          continue;
        }

        const receivedAt = message.internalDate?.getTime() || 0;
        const existing = parsedByDate.get(date);
        if (!existing || receivedAt >= existing.receivedAt) {
          parsedByDate.set(date, { nav, receivedAt });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  if (process.env.DEBUG_MAIL === "1") {
    console.log(`Mailbox candidates: ${candidateMessages}; sender matches: ${senderMessages}`);
  }
  return Object.fromEntries(
    [...parsedByDate.entries()].map(([date, value]) => [date, round(value.nav)])
  );
}

async function fetchOfficialIndex(indexCode, startDate, endDate) {
  const url = new URL("https://www.csindex.com.cn/csindex-home/perf/index-perf");
  url.searchParams.set("indexCode", indexCode);
  url.searchParams.set("startDate", compactDate(startDate));
  url.searchParams.set("endDate", compactDate(endDate));
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "DavisDailyTracking/1.0"
    },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Index request failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.code !== "200" || !Array.isArray(payload.data)) {
    throw new Error(`Index request failed: ${payload.msg || "unknown error"}`);
  }
  return Object.fromEntries(
    payload.data
      .filter(row => row.tradeDate && Number.isFinite(Number(row.close)))
      .map(row => [
        `${row.tradeDate.slice(0, 4)}-${row.tradeDate.slice(4, 6)}-${row.tradeDate.slice(6, 8)}`,
        Number(row.close)
      ])
  );
}

function buildSiteData(state) {
  const dates = Object.keys(state.fundNavs)
    .filter(date => state.priceIndex[date] != null && state.totalReturnIndex[date] != null)
    .sort();
  if (!dates.length) throw new Error("No complete fund and index observations are available");

  const points = [
    {
      date: "06-30 期初",
      axisLabel: "06-30",
      nav: state.fundBaseNav,
      priceIndex: state.priceBase,
      totalReturnIndex: state.totalReturnBase,
      inferredAnchor: true
    },
    ...dates.map(date => ({
      date: axisLabel(date),
      axisLabel: axisLabel(date),
      nav: state.fundNavs[date],
      priceIndex: state.priceIndex[date],
      totalReturnIndex: state.totalReturnIndex[date]
    }))
  ];

  return {
    updatedAt: dates.at(-1),
    lastCheckedAt: state.lastCheckedAt || null,
    fundBaseNav: state.fundBaseNav,
    priceBase: state.priceBase,
    totalReturnBase: state.totalReturnBase,
    points
  };
}

async function main() {
  const state = await readJson(STATE_PATH);
  const today = shanghaiToday();
  const previousPublishedDate = buildSiteData(state).updatedAt;
  const [mailNavs, priceIndex, totalReturnIndex] = await Promise.all([
    fetchFundNavs(),
    fetchOfficialIndex("000922", state.indexBaseDate, today),
    fetchOfficialIndex("H00922", state.indexBaseDate, today)
  ]);

  state.fundNavs = {
    ...state.fundNavs,
    ...mailNavs,
    ...state.fundNavOverrides
  };
  state.priceIndex = { ...state.priceIndex, ...priceIndex };
  state.totalReturnIndex = { ...state.totalReturnIndex, ...totalReturnIndex };
  state.lastCheckedAt = shanghaiNow();

  const siteData = buildSiteData(state);
  const latestMailboxDate = Object.keys(mailNavs).sort().at(-1);
  if (
    siteData.updatedAt > previousPublishedDate &&
    latestMailboxDate === siteData.updatedAt
  ) {
    state.lastSuccessfulCheckDate = today;
  }
  const stateText = `${JSON.stringify(state, null, 2)}\n`;
  const siteText = `window.DAVIS_DATA = ${JSON.stringify(siteData, null, 2)};\n`;
  const siteJsonText = `${JSON.stringify(siteData, null, 2)}\n`;
  await fs.writeFile(STATE_PATH, stateText);
  await fs.writeFile(SITE_DATA_PATH, siteText);
  await fs.writeFile(path.join(ROOT, "site", "data.json"), siteJsonText);

  console.log(`Mailbox valuation dates parsed: ${Object.keys(mailNavs).length}`);
  console.log(`Dashboard published through: ${siteData.updatedAt}`);
  console.log(
    state.lastSuccessfulCheckDate === today
      ? "Today's update is complete; later scheduled checks will be skipped"
      : "No new complete valuation yet; the next hourly check remains enabled"
  );
}

await main();
