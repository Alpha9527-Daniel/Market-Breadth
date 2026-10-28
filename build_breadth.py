#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
市场宽广度 · 红盘率 + 阿姆氏指标(TRIN) 每日构建脚本

数据源：AKShare 与同源公开接口
  - 交易日历      ak.tool_trade_date_hist_sina()
  - 全市场快照    ak.stock_zh_a_spot()            （1 次请求，取最近一个收盘日的全部 A 股）
  - 逐股日线      ak.stock_zh_a_daily(symbol=..)  （历史回补时按股票拉取，多线程）
  - 指数日线      腾讯行情接口（东财/新浪为备份）
  - 指数成分股    ak.index_stock_cons()           （新浪，本地缓存 7 天）

产物：
  data/cache/xsec/YYYYMMDD.csv.gz   每个交易日的个股横截面（code, pct, volume, amount）
  data/cache/cons/{指数}.csv        各板块成分股（用于分板块宽度）
  data/cache/index/{指数}.csv       指数日线（用于 K 线图）
  data/breadth_history.csv          指标历史（沪深 A 股口径）
  docs/data/breadth.json / .js      前端数据

指标口径（详见 README.md「指标口径」）：
  红盘率        = 上涨家数 / (上涨 + 下跌 + 平盘)      —— 停牌股剔除
  TRIN          = (上涨家数 / 下跌家数) / (上涨成交量 / 下跌成交量)
  量比(额)      = 上涨成交额 / 下跌成交额
  相关系数      = TRIN(t-k) 与所属板块指数涨跌幅的 120 个交易日滚动皮尔逊相关

用法：
  python build_breadth.py                 # 每日运行：补当日快照 + 导出前端数据
  python build_breadth.py --backfill 260  # 首跑/补历史：回补 260 个交易日
  python build_breadth.py --rebuild       # 不联网重算（用本地缓存），调试用
  python build_breadth.py --limit 300     # 冒烟测试：只取 300 只股票
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import os
import sys
import time

# akshare 内部用 tqdm 打进度条，日志里会刷屏，这里关掉
os.environ.setdefault("TQDM_DISABLE", "1")

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd

# --------------------------------------------------------------------------- 配置
ROOT = Path(__file__).resolve().parent
CACHE_DIR = ROOT / "data" / "cache" / "xsec"          # 每日个股横截面归档
CONS_DIR = ROOT / "data" / "cache" / "cons"           # 板块成分股
INDEX_DIR = ROOT / "data" / "cache" / "index"         # 指数日线
HIST_CSV = ROOT / "data" / "breadth_history.csv"      # 指标历史（沪深 A 股）
DOCS_DATA = ROOT / "docs" / "data"                    # 前端数据
OUT_JSON = DOCS_DATA / "breadth.json"
# 同一份数据的 <script> 版本：直接双击打开 index.html（file://）时浏览器会拦截 fetch，
# 只能靠 <script src> 把数据带进来，所以两个文件都要生成。
OUT_JS = DOCS_DATA / "breadth.js"

UNIVERSE_PREFIX = ("sh", "sz")   # 沪深 A 股；北交所(bj)成交极小且接口不全，默认剔除
BACKFILL_DEFAULT = 120           # 日常补齐的交易日数
KEEP_DAYS = 260                  # 归档保留的交易日数（约一年）
WORKERS = 12                     # 逐股日线并发数
MIN_COVERAGE = 0.90              # 单日覆盖率低于此值视为抓取失败，不写归档
FLAT_EPS = 0.0001                # |涨跌幅| <= 0.0001(%) 视为平盘
CORR_WINDOW = 120                # 相关系数滚动窗口（交易日）
CORR_LAGS = (1, 10)              # TRIN 的滞后阶数：t-1 / t-10
CONS_TTL_DAYS = 7                # 成分股缓存有效期（天）

# 交易时段（用于判断全市场快照代表哪一天的收盘数据）
MKT_OPEN = dt.time(9, 15)
MKT_SETTLED = dt.time(15, 5)     # 收盘 + 5 分钟缓冲，之后快照即当日收盘数据

# 指数：代码 -> 名称（腾讯行情符号）
INDEX_SYMBOLS = {
    "sh000001": "上证综指",
    "sh000985": "中证全指",
    "sh000300": "沪深300",
    "sz399006": "创业板指",
    "sh000688": "科创50",
    "sh000698": "科创100",
}
BENCHMARKS = ("sh000001", "sh000985")   # 基准指数（保留：板块指数之外想加对照时可引用）

# 板块：宽度样本 + K 线对应的指数
MARKETS = [
    {"key": "all", "name": "沪深A股", "index": "sh000001", "cons": None},
    {"key": "hs300", "name": "沪深300", "index": "sh000300", "cons": "000300"},
    {"key": "cyb", "name": "创业板", "index": "sz399006", "cons": "399006"},
    {"key": "kc50", "name": "科创50", "index": "sh000688", "cons": "000688"},
    {"key": "kc100", "name": "科创100", "index": "sh000698", "cons": "000698"},
]


def log(msg: str) -> None:
    print(f"[{dt.datetime.now():%H:%M:%S}] {msg}", flush=True)


def _num(v) -> float:
    """把可能为 None/NaN 的数值安全转成 float（缺失记为 0）。"""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    return 0.0 if f != f or f in (float("inf"), float("-inf")) else f


# --------------------------------------------------------------------------- 日历
def trading_calendar() -> list[dt.date]:
    """交易日历（新浪，覆盖历史与未来已排定的日期）。"""
    import akshare as ak

    df = ak.tool_trade_date_hist_sina()
    days = pd.to_datetime(df[df.columns[0]]).dt.date.tolist()
    return sorted(set(days))


def prev_trading_day(cal: list[dt.date], day: dt.date) -> dt.date | None:
    earlier = [d for d in cal if d < day]
    return earlier[-1] if earlier else None


def spot_session(cal: list[dt.date], now: dt.datetime) -> dt.date | None:
    """判断此刻的全市场快照对应哪一个交易日的收盘数据。

    - 交易日 15:05 之后          -> 当天
    - 交易日 09:15 之前          -> 上一个交易日（快照仍是上一交易日的收盘数据）
    - 盘中 09:15~15:05           -> None（数据未定盘，不落库）
    - 非交易日                    -> 最近一个已收盘的交易日
    """
    today = now.date()
    prev = prev_trading_day(cal, today)
    if today in cal:
        if now.time() >= MKT_SETTLED:
            return today
        if now.time() < MKT_OPEN:
            return prev
        return None
    return prev


# --------------------------------------------------------------------------- 取数：个股
def fetch_spot() -> pd.DataFrame:
    """全市场快照 -> DataFrame[code, pct, volume, amount]（一次请求，约 10 秒）。"""
    import akshare as ak

    df = ak.stock_zh_a_spot()
    df = df.rename(columns={"代码": "code", "涨跌幅": "pct", "成交量": "volume", "成交额": "amount"})
    df = df[["code", "pct", "volume", "amount"]].copy()
    df["code"] = df["code"].astype(str).str.lower().str.strip()
    df = df[df["code"].str[:2].isin(UNIVERSE_PREFIX)]
    for c in ("pct", "volume", "amount"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.dropna(subset=["pct"])
    return df.reset_index(drop=True)


def spot_looks_valid(df: pd.DataFrame) -> bool:
    """盘前或接口异常时，快照可能是空的/全零的，这种数据宁可不落库。"""
    if len(df) < 3000:
        return False
    traded = (pd.to_numeric(df["volume"], errors="coerce").fillna(0) > 0).mean()
    return traded >= 0.5


def fetch_kline_one(code: str, start: dt.date, end: dt.date) -> tuple[str, pd.DataFrame | None]:
    """单只股票的日线（含 start 前的少量回看，用于算首日涨跌幅）。"""
    import akshare as ak

    lookback = start - dt.timedelta(days=20)
    for attempt in range(3):
        try:
            df = ak.stock_zh_a_daily(
                symbol=code, start_date=lookback.strftime("%Y%m%d"),
                end_date=end.strftime("%Y%m%d"), adjust="",
            )
            if df is None or len(df) == 0:
                return code, None
            df = df[["date", "close", "volume", "amount"]].copy()
            df["date"] = pd.to_datetime(df["date"]).dt.date
            df["pct"] = df["close"].pct_change(fill_method=None) * 100
            df = df[df["date"] >= start]
            df = df[df["pct"].notna()]
            return code, df[["date", "pct", "volume", "amount"]]
        except Exception:                                    # noqa: BLE001 - 网络接口不稳定，重试即可
            time.sleep(0.6 * (attempt + 1))
    return code, None


def backfill(days: list[dt.date], limit: int = 0) -> int:
    """用逐股日线补齐缺失日期，按日写入横截面归档。返回补齐的日期数。"""
    missing = [d for d in days if not xsec_path(d).exists()]
    if not missing:
        return 0

    start, end = min(missing), max(missing)
    log(f"需要回补 {len(missing)} 个交易日：{start} ~ {end}")

    codes = fetch_spot()["code"].tolist()
    if limit:
        codes = codes[:limit]
    log(f"股票池 {len(codes)} 只，并发 {WORKERS}，预计 {len(codes) / 6 / 60:.0f} 分钟")

    by_date: dict[dt.date, list[tuple]] = {d: [] for d in missing}
    failed: list[str] = []
    done = 0
    t0 = time.time()

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(fetch_kline_one, c, start, end) for c in codes]
        for fut in futures:
            code, df = fut.result()
            done += 1
            if df is None or df.empty:
                failed.append(code)
            else:
                for row in df.itertuples(index=False):
                    bucket = by_date.get(row.date)
                    if bucket is not None:
                        bucket.append((code, float(row.pct), _num(row.volume), _num(row.amount)))
            if done % 400 == 0 or done == len(codes):
                elapsed = time.time() - t0
                eta = elapsed / done * (len(codes) - done)
                log(f"  {done}/{len(codes)}  已用 {elapsed / 60:.1f} 分钟  剩余 {eta / 60:.1f} 分钟  失败 {len(failed)}")

    written = 0
    for day in missing:
        rows = by_date[day]
        coverage = len(rows) / len(codes) if codes else 0
        if coverage < MIN_COVERAGE:
            log(f"  {day} 覆盖率仅 {coverage:.1%}，跳过不写（下次运行会重试）")
            continue
        save_xsec(day, pd.DataFrame(rows, columns=["code", "pct", "volume", "amount"]))
        written += 1

    if failed:
        log(f"  {len(failed)} 只股票取数失败（多为新股/停牌/退市）：{', '.join(failed[:8])}...")
    log(f"回补完成：写入 {written} 个交易日")
    return written


# --------------------------------------------------------------------------- 取数：指数与成分股
def fetch_index_bars(symbol: str, count: int = 400) -> pd.DataFrame | None:
    """指数日线 -> DataFrame[date, open, high, low, close]（腾讯行情，0.3 秒/只）。"""
    import requests

    url = f"https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={symbol},day,,,{count},qfq"
    try:
        resp = requests.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
        node = resp.json()["data"][symbol]
        rows = node.get("day") or node.get("qfqday")
        df = pd.DataFrame([{
            "date": r[0], "open": float(r[1]), "close": float(r[2]),
            "high": float(r[3]), "low": float(r[4]),
        } for r in rows])
        return df[["date", "open", "high", "low", "close"]]
    except Exception as exc:                                 # noqa: BLE001 - 备份源兜底
        log(f"  腾讯指数接口失败（{symbol}）：{type(exc).__name__}，改用新浪")
    try:
        import akshare as ak

        df = ak.stock_zh_index_daily(symbol=symbol)
        df = df.rename(columns={"date": "date"})[["date", "open", "high", "low", "close"]]
        df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
        return df
    except Exception as exc:                                 # noqa: BLE001
        log(f"  指数取数失败（{symbol}）：{type(exc).__name__}")
        return None


def refresh_indices(rebuild: bool = False) -> dict[str, pd.DataFrame]:
    """取六个指数的日线；--rebuild 时只读本地缓存。"""
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    out: dict[str, pd.DataFrame] = {}
    for sym in INDEX_SYMBOLS:
        cache = INDEX_DIR / f"{sym}.csv"
        if rebuild:
            if cache.exists():
                out[sym] = pd.read_csv(cache, dtype={"date": str})
            continue
        df = fetch_index_bars(sym)
        if df is None or df.empty:
            if cache.exists():                              # 网络失败就用上次的
                out[sym] = pd.read_csv(cache, dtype={"date": str})
            continue
        df.to_csv(cache, index=False, encoding="utf-8")
        out[sym] = df
    log(f"指数日线：{len(out)}/{len(INDEX_SYMBOLS)} 只可用")
    return out


def to_sina_code(code: str) -> str:
    """六位代码 -> 带交易所前缀（用于和个股横截面对齐）。"""
    code = str(code).strip().zfill(6)
    if code.startswith("6"):
        return "sh" + code
    if code.startswith(("0", "3")):
        return "sz" + code
    return "bj" + code


def cons_cache_fresh(cache: Path) -> bool:
    """成分股缓存是否仍在有效期内。

    用文件里记录的 asof 日期判断，而不是文件 mtime——Git 检出后 mtime 都是"现在"，
    用 mtime 会让云端永远认为缓存是新的。
    """
    if not cache.exists():
        return False
    try:
        df = pd.read_csv(cache, dtype={"code": str})
    except Exception:                                        # noqa: BLE001
        return False
    if df.empty or "asof" not in df.columns:
        return False
    asof = pd.to_datetime(df["asof"].iloc[0], errors="coerce")
    if pd.isna(asof):
        return False
    return (dt.date.today() - asof.date()).days < CONS_TTL_DAYS


def load_constituents(market: dict, rebuild: bool = False) -> set[str] | None:
    """板块成分股（新浪，缓存 7 天）。返回带前缀的代码集合。"""
    idx_code = market["cons"]
    if idx_code is None:
        return None                                        # 沪深A股 = 全样本
    cache = CONS_DIR / f"{idx_code}.csv"
    fresh = cons_cache_fresh(cache)
    if rebuild and cache.exists():
        return set(pd.read_csv(cache, dtype={"code": str})["code"].str.lower())
    if fresh:
        return set(pd.read_csv(cache, dtype={"code": str})["code"].str.lower())
    try:
        import akshare as ak

        df = ak.index_stock_cons(symbol=idx_code)
        codes = [to_sina_code(c) for c in df.iloc[:, 0].astype(str).tolist()]
        CONS_DIR.mkdir(parents=True, exist_ok=True)
        pd.DataFrame({"code": codes, "asof": dt.date.today().isoformat()}).to_csv(
            cache, index=False, encoding="utf-8")
        log(f"  成分股 {idx_code}：{len(codes)} 只（已更新缓存）")
        return set(codes)
    except Exception as exc:                                 # noqa: BLE001
        log(f"  成分股 {idx_code} 取数失败：{type(exc).__name__}，沿用旧缓存")
        if cache.exists():
            return set(pd.read_csv(cache, dtype={"code": str})["code"].str.lower())
        return None


# --------------------------------------------------------------------------- 归档 IO
def xsec_path(day: dt.date) -> Path:
    return CACHE_DIR / f"{day:%Y%m%d}.csv.gz"


def save_xsec(day: dt.date, df: pd.DataFrame) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = xsec_path(day).with_suffix(".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8", newline="") as fh:
        df.to_csv(fh, index=False, float_format="%.4f")
    tmp.replace(xsec_path(day))


def load_xsec(day: dt.date) -> pd.DataFrame | None:
    path = xsec_path(day)
    if not path.exists():
        return None
    return pd.read_csv(path, compression="gzip")


def cached_days() -> list[dt.date]:
    if not CACHE_DIR.exists():
        return []
    days = []
    for p in CACHE_DIR.glob("*.csv.gz"):
        try:
            days.append(dt.datetime.strptime(p.stem.split(".")[0], "%Y%m%d").date())
        except ValueError:
            continue
    return sorted(days)


def prune(days: list[dt.date]) -> None:
    """只保留最近 KEEP_DAYS 个交易日，避免仓库膨胀。"""
    if len(days) <= KEEP_DAYS:
        return
    for day in days[:-KEEP_DAYS]:
        xsec_path(day).unlink(missing_ok=True)


# --------------------------------------------------------------------------- 指标
def aggregate(day: dt.date, df: pd.DataFrame) -> dict:
    """单日横截面 -> 红盘率 / TRIN / 量比 / 成交额。"""
    pct = pd.to_numeric(df["pct"], errors="coerce")
    vol = pd.to_numeric(df["volume"], errors="coerce").fillna(0.0)
    amt = pd.to_numeric(df["amount"], errors="coerce").fillna(0.0)

    traded = (vol > 0) & pct.notna()          # 有成交才算有效样本；停牌股剔除
    up = (pct > FLAT_EPS) & traded
    down = (pct < -FLAT_EPS) & traded

    adv, dec, flat = int(up.sum()), int(down.sum()), int(((pct.abs() <= FLAT_EPS) & traded).sum())
    total = adv + dec + flat

    adv_vol, dec_vol = float(vol[up].sum()), float(vol[down].sum())
    adv_amt, dec_amt = float(amt[up].sum()), float(amt[down].sum())

    adv_ratio = adv / total * 100 if total else None       # 红盘率(%)
    vol_ratio = adv_vol / dec_vol if dec_vol > 0 else None  # 量比（股）
    vol_ratio_amt = adv_amt / dec_amt if dec_amt > 0 else None  # 量比（额）
    trin = None
    if dec > 0 and vol_ratio:
        trin = round((adv / dec) / vol_ratio, 4)

    return {
        "date": day.isoformat(),
        "adv": adv, "dec": dec, "flat": flat,
        "susp": int((~traded).sum()), "total": total,
        "adv_ratio": round(adv_ratio, 2) if adv_ratio is not None else None,
        "trin": trin,
        "adv_vol": adv_vol, "dec_vol": dec_vol,
        "vol_ratio": round(vol_ratio, 4) if vol_ratio else None,
        "vol_ratio_amt": round(vol_ratio_amt, 4) if vol_ratio_amt else None,
        "amount_yi": round(float(amt.sum()) / 1e8, 1),     # 两市成交额（亿元）
    }


def rolling_corr(x: pd.Series, y: pd.Series, window: int = CORR_WINDOW, min_pairs: int = 100) -> pd.Series:
    """滚动皮尔逊相关：窗口内按有效配对计算（个别日 TRIN 无定义也不至于整段作废）。"""
    xa, ya = x.to_numpy(dtype=float), y.to_numpy(dtype=float)
    out = []
    for i in range(len(xa)):
        lo = max(0, i - window + 1)
        a, b = xa[lo:i + 1], ya[lo:i + 1]
        mask = ~(pd.isna(a) | pd.isna(b))
        n = int(mask.sum())
        if n < min_pairs:
            out.append(None)
            continue
        va, vb = a[mask], b[mask]
        if va.std() == 0 or vb.std() == 0:
            out.append(None)
            continue
        out.append(round(float(((va - va.mean()) * (vb - vb.mean())).sum() /
                               ((va - va.mean()).std(ddof=0) * (vb - vb.mean()).std(ddof=0) * n)), 3))
    return pd.Series(out, index=x.index)


def build_market_series(market: dict, days: list[dt.date], indices: dict[str, pd.DataFrame],
                        cons: set[str] | None) -> pd.DataFrame:
    """某个板块的逐日指标 + 与该板块指数涨跌幅的相关系数。"""
    # 板块对应指数的涨跌幅（按日期索引）
    idx_sym = market["index"]
    idx_pct: dict[str, float] = {}
    df_idx = indices.get(idx_sym)
    if df_idx is not None and not df_idx.empty:
        close = pd.to_numeric(df_idx["close"], errors="coerce")
        pct = close.pct_change(fill_method=None) * 100
        idx_pct = dict(zip(df_idx["date"].astype(str), pct.round(2)))

    rows = []
    for day in days:
        xsec = load_xsec(day)
        if xsec is None or xsec.empty:
            continue
        if cons is not None:
            xsec = xsec[xsec["code"].isin(cons)]
            if len(xsec) < 10:
                continue
        agg = aggregate(day, xsec)
        agg["idx_pct"] = idx_pct.get(agg["date"])
        rows.append(agg)

    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df = df.sort_values("date").reset_index(drop=True)

    # TRIN(t-k) 与板块指数涨跌幅的滚动相关系数
    trin = pd.to_numeric(df["trin"], errors="coerce")
    idx_pct_series = pd.to_numeric(df["idx_pct"], errors="coerce")
    for lag in CORR_LAGS:
        df[f"corr_t{lag}"] = rolling_corr(trin.shift(lag), idx_pct_series)
    return df


def export_json(series_by_market: dict[str, pd.DataFrame], indices: dict[str, pd.DataFrame]) -> None:
    """导出前端数据：各板块序列 + 指数 K 线。"""
    DOCS_DATA.mkdir(parents=True, exist_ok=True)

    markets = []
    for market in MARKETS:
        df = series_by_market.get(market["key"])
        if df is None or df.empty:
            continue
        rows = []
        for r in df.to_dict("records"):
            rows.append({
                "d": r["date"],
                "adv": r["adv"], "dec": r["dec"], "flat": r["flat"],
                "susp": r["susp"], "total": r["total"],
                "advRatio": r["adv_ratio"],
                "trin": None if pd.isna(r["trin"]) else r["trin"],
                "advVolYi": round(r["adv_vol"] / 1e8, 1),
                "decVolYi": round(r["dec_vol"] / 1e8, 1),
                "volRatio": None if pd.isna(r["vol_ratio"]) else r["vol_ratio"],
                "volRatioAmt": None if pd.isna(r["vol_ratio_amt"]) else r["vol_ratio_amt"],
                "amountYi": r["amount_yi"],
                "idxPct": None if pd.isna(r.get("idx_pct")) else r.get("idx_pct"),
                "corr": {
                    "t1": None if pd.isna(r.get("corr_t1")) else r.get("corr_t1"),
                    "t10": None if pd.isna(r.get("corr_t10")) else r.get("corr_t10"),
                },
            })
        markets.append({
            "key": market["key"], "name": market["name"],
            "index": market["index"], "indexName": INDEX_SYMBOLS[market["index"]],
            "size": rows[-1]["total"],                     # 最新一天的样本只数
            "series": rows,
        })

    idx_payload = {}
    for sym, df in indices.items():
        if df is None or df.empty:
            continue
        bars = [[str(t.date), round(float(t.open), 2), round(float(t.high), 2),
                 round(float(t.low), 2), round(float(t.close), 2)]
                for t in df.tail(320).itertuples(index=False)]
        idx_payload[sym] = {"name": INDEX_SYMBOLS[sym], "bars": bars}

    payload = {
        "generatedAt": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "source": "AKShare · 新浪财经 / 腾讯财经 / 东方财富",
        "corrWindow": CORR_WINDOW,
        "definition": {
            "advRatio": "红盘率 = 上涨家数 / (上涨 + 下跌 + 平盘)，停牌股剔除",
            "trin": "TRIN = (上涨家数 / 下跌家数) / (上涨成交量 / 下跌成交量)",
            "volRatioAmt": "量比(额) = 上涨成交额 / 下跌成交额",
            "corr": "TRIN(t-k) 与所属板块指数当日涨跌幅的 120 个交易日滚动相关系数",
        },
        "markets": markets,
        "indices": idx_payload,
    }

    OUT_JSON.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    OUT_JS.write_text(
        "window.BREADTH_DATA = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    total = sum(len(m["series"]) for m in markets)
    log(f"已导出 {OUT_JSON.relative_to(ROOT)} 与 {OUT_JS.relative_to(ROOT)}"
        f"（{len(markets)} 个板块 / {total} 行，最新 {markets[0]['series'][-1]['d'] if markets else '—'}）")


# --------------------------------------------------------------------------- 主流程
def main() -> int:
    ap = argparse.ArgumentParser(description="红盘率 + 阿姆氏指标(TRIN) 每日构建")
    ap.add_argument("--backfill", type=int, default=BACKFILL_DEFAULT,
                    help=f"补齐最近 N 个交易日（默认 {BACKFILL_DEFAULT}）")
    ap.add_argument("--rebuild", action="store_true", help="不联网，仅用本地缓存重算并导出")
    ap.add_argument("--limit", type=int, default=0, help="冒烟测试：只用前 N 只股票")
    args = ap.parse_args()

    try:                                     # Windows 控制台中文输出
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:                        # noqa: BLE001
        pass

    now = dt.datetime.now()
    cal = trading_calendar()
    session = spot_session(cal, now)
    log(f"交易日历最新 {cal[-1]}；当前 {now:%Y-%m-%d %H:%M}；快照对应交易日 {session or '（盘中，跳过）'}")

    if not args.rebuild and session is not None and not xsec_path(session).exists():
        df = fetch_spot()
        if args.limit:
            df = df.head(args.limit)
        log(f"全市场快照：{len(df)} 只股票")
        if args.limit:
            log("冒烟测试模式：不写入当日归档")
        elif not spot_looks_valid(df):
            log("快照异常（有效成交股票过少，多为盘前空数据），跳过归档，改用逐股日线补齐")
        else:
            save_xsec(session, df)
            log(f"已归档 {session}")

    if not args.rebuild:
        days = [d for d in cal if d <= (session or prev_trading_day(cal, now.date()))]
        backfill(days[-max(args.backfill, 10):], limit=args.limit)

    days = cached_days()
    if not days:
        log("没有可用的横截面归档，退出")
        return 1
    prune(days)
    days = days[-KEEP_DAYS:]
    log(f"横截面归档：{len(days)} 个交易日（{days[0]} ~ {days[-1]}）")

    log("取指数日线与板块成分股 …")
    indices = refresh_indices(rebuild=args.rebuild)

    series_by_market: dict[str, pd.DataFrame] = {}
    for market in MARKETS:
        cons = load_constituents(market, rebuild=args.rebuild)
        df = build_market_series(market, days, indices, cons)
        if df.empty:
            log(f"  {market['name']}：无数据，跳过")
            continue
        series_by_market[market["key"]] = df
        log(f"  {market['name']}：{len(df)} 个交易日，最新样本 {int(df.iloc[-1]['total'])} 只")

    if not series_by_market:
        log("没有可用板块数据，退出")
        return 1

    # 沪深 A 股口径落到 CSV，便于本地核查
    all_df = series_by_market.get("all")
    if all_df is not None:
        out = all_df.copy()
        for col in ("adv_vol", "dec_vol"):
            out[col] = (out[col] / 1e8).round(1)
        out = out.rename(columns={"adv_vol": "adv_vol_yi", "dec_vol": "dec_vol_yi"})
        HIST_CSV.parent.mkdir(parents=True, exist_ok=True)
        out.to_csv(HIST_CSV, index=False, encoding="utf-8-sig")

    export_json(series_by_market, indices)
    latest = series_by_market["all"].iloc[-1]
    log(f"最新 {latest['date']}：红盘率 {latest['adv_ratio']:.2f}%  TRIN {latest['trin']}  "
        f"(涨 {latest['adv']} / 跌 {latest['dec']} / 平 {latest['flat']})  "
        f"ρ(t-1) {latest.get('corr_t1')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
