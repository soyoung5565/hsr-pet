#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""多渠道聚合搜索：中文走豆包Custom+千帆，英文走Tavily+豆包Global。"""
import json, os, sys, urllib.request, urllib.parse, io, time

SK = r"D:\hermes-data\skills\multi-search-engine"
K = json.load(open(os.path.join(SK, "api-keys.json"), encoding="utf-8"))["channels"]

def post(url, payload, headers, timeout=45):
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))

def doubao_cn(q, n=5):
    try:
        d = post(K["doubao"]["endpoint_custom"],
                 {"Query": q, "SearchType": "web", "Count": n,
                  "Filter": {"NeedUrl": True}, "QueryControl": {"QueryRewrite": False}},
                 {"Authorization": "Bearer " + K["doubao"]["api_key"]})
        out = []
        for it in d.get("Data", {}).get("Result", []) or []:
            out.append({"title": it.get("Title", ""), "url": it.get("Url", ""),
                        "snip": (it.get("Snippet") or it.get("Summary") or "")[:600]})
        return out
    except Exception as e:
        return [{"title": "ERROR", "url": "", "snip": repr(e)[:300]}]

def doubao_global(q, n=6):
    try:
        d = post(K["doubao"]["endpoint_global"],
                 {"SearchType": "web", "Query": q, "DocCount": n, "MaxSnippetLength": 800},
                 {"Authorization": "Bearer " + K["doubao"]["api_key_global"]})
        out = []
        for it in d.get("Data", {}).get("Result", []) or []:
            out.append({"title": it.get("Title", ""), "url": it.get("Url", ""),
                        "snip": (it.get("Snippet") or "")[:600]})
        return out
    except Exception as e:
        return [{"title": "ERROR", "url": "", "snip": repr(e)[:300]}]

def tavily(q, n=6):
    try:
        d = post("https://api.tavily.com/search",
                 {"api_key": K["tavily"]["api_key"], "query": q,
                  "max_results": n, "search_depth": "advanced"},
                 {})
        return [{"title": r.get("title", ""), "url": r.get("url", ""),
                 "snip": (r.get("content") or "")[:600]} for r in d.get("results", [])]
    except Exception as e:
        return [{"title": "ERROR", "url": "", "snip": repr(e)[:300]}]

def qianfan(q, n=5):
    try:
        d = post("https://qianfan.baidubce.com/v2/ai_search/web_search",
                 {"messages": [{"content": q, "role": "user"}],
                  "search_source": "baidu_search_v2",
                  "resource_type_filter": [{"type": "web", "top_k": n}]},
                 {"Authorization": "Bearer " + K["baidu_qianfan"]["api_key"],
                  "X-Appbuilder-From": "openmaic"})
        out = []
        for it in d.get("references", []) or []:
            out.append({"title": it.get("title", ""), "url": it.get("url", ""),
                        "snip": (it.get("content") or "")[:600]})
        return out
    except Exception as e:
        return [{"title": "ERROR", "url": "", "snip": repr(e)[:300]}]

ENGINES = {"doubao_cn": doubao_cn, "qianfan": qianfan,
           "tavily": tavily, "doubao_global": doubao_global}

if __name__ == "__main__":
    queries = json.load(open(sys.argv[1], encoding="utf-8"))
    for item in queries:
        q = item["q"]
        print("=" * 100)
        print("QUERY:", q)
        for eng in item.get("engines", ["doubao_cn", "tavily"]):
            print("-" * 30, eng)
            for r in ENGINES[eng](q, item.get("n", 5)):
                if r["title"] == "ERROR":
                    print("  [FAIL]", r["snip"]); continue
                print("  *", r["title"][:110])
                print("    ", r["url"][:150])
                print("    ", r["snip"].replace("\n", " ")[:420])
            time.sleep(0.6)
