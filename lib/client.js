/**
 * dsh-lan-proxy 浏览器端 bundle（单文件，经 __ModuleLoader__ 加载）。
 *
 * 向 `settings.plugin.item` 槽位注册卡片（key = settings 命名空间 `lan-proxy`），
 * 渲染「设置 → 插件配置 → Lan Proxy」：显示当前登录验证码与剩余有效时间。
 *
 * 数据通道：自有 RPC POST /api/lan-proxy/code（走 dsh 统一的 Host/Origin 栅栏
 * + cookie 鉴权，故只有已登录的本机会话能读到）。
 */
window.__ModuleLoader__.load({
  id: "dsh-lan-proxy",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");

    const NS = "lan-proxy";
    const name = "dsh-lan-proxy";
    const inject = ["slots"];

    // 复用设置页主题令牌，与其它插件卡片观感一致
    const cssText =
      ".lp_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none}" +
      ".lp_header{display:flex;align-items:center;gap:12px;padding:14px 16px}" +
      ".lp_title{font-weight:600;flex:1}" +
      ".lp_desc{color:var(--dsw-alias-label-secondary);font-size:13px;padding:0 16px 14px}" +
      ".lp_body{padding:0 16px 16px;border-top:1px solid var(--dsw-alias-border-l2)}" +
      ".lp_code{font-size:40px;font-weight:700;letter-spacing:.22em;font-variant-numeric:tabular-nums;text-align:center;padding:18px 0 10px}" +
      ".lp_bar{height:4px;border-radius:2px;background:var(--dsw-alias-border-l2);overflow:hidden;margin:0 0 10px}" +
      ".lp_barIn{display:block;height:100%;background:var(--dsw-alias-brand-primary);transition:width .9s linear}" +
      ".lp_meta{color:var(--dsw-alias-label-secondary);font-size:13px;text-align:center}" +
      ".lp_err{color:var(--dsw-alias-label-error,#ff9a9a);font-size:13px;text-align:center;padding:12px 0}" +
      ".lp_off{color:var(--dsw-alias-label-secondary);font-size:13px;padding:14px 0;text-align:center}" +
      ".lp_actions{display:flex;gap:8px;margin-top:14px}" +
      ".lp_btn,.lp_btnGhost{flex:1;padding:10px;font:inherit;font-size:14px;font-weight:600;border:0;border-radius:9px;cursor:pointer}" +
      ".lp_btn{background:var(--dsw-alias-brand-primary);color:#fff}" +
      ".lp_btnGhost{background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2)}" +
      ".lp_btn:disabled,.lp_btnGhost:disabled{opacity:.55;cursor:default}" +
      ".lp_body .lp_btn{display:block;width:100%;margin-top:12px}" +
      ".lp_sub{display:flex;align-items:center;justify-content:space-between;font-size:13px;font-weight:600;margin-bottom:10px}" +
      ".lp_dev{display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--dsw-alias-border-l2)}" +
      ".lp_devMain{flex:1;min-width:0}" +
      ".lp_devName{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".lp_devMeta{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".lp_devBtn{flex:0 0 auto;padding:6px 12px;font:inherit;font-size:12px;font-weight:600;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer}" +
      ".lp_devBtn:hover:not(:disabled){color:var(--dsw-alias-label-error,#ff9a9a);border-color:var(--dsw-alias-label-error,#ff9a9a)}" +
      ".lp_devBtn:disabled{opacity:.55;cursor:default}" +
      ".lp_devAll{margin-top:10px}";
    const tagId = "dsh-lan-proxy/card.css";
    if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-lan-proxy";
      tag.dataset.pluginCss = tagId;
      tag.textContent = cssText;
      document.head.appendChild(tag);
    }

    const POLL_MS = 5000;

    function LanProxyCard() {
      const [view, setView] = React.useState(null);
      const [devices, setDevices] = React.useState([]);
      const [err, setErr] = React.useState("");
      const [busy, setBusy] = React.useState(false);

      const rpc = React.useCallback(async (method, payload) => {
        const rpcId = "c" + Math.random().toString(36).slice(2);
        const res = await fetch("/api/lan-proxy/code", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "client-request", method, rpcId, payload: payload || {} })
        });
        const data = await res.json();
        const result = data && data.result;
        if (result && result.ok) return result.value;
        throw new Error((result && result.error && result.error.message) || "读取失败");
      }, []);

      const refresh = React.useCallback(async () => {
        try {
          const [st, dv] = await Promise.all([rpc("status"), rpc("devices")]);
          setView(st);
          setDevices((dv && dv.devices) || []);
          setErr("");
        } catch (e) {
          setView(null);
          setErr(String((e && e.message) || e));
        }
      }, [rpc]);

      React.useEffect(() => {
        let alive = true;
        const tick = () => { if (alive) refresh(); };
        tick();
        const timer = setInterval(tick, POLL_MS);
        return () => { alive = false; clearInterval(timer); };
      }, [refresh]);

      async function act(method, payload) {
        setBusy(true);
        try {
          const value = await rpc(method, payload);
          if (value && value.devices) { setDevices(value.devices); setView(await rpc("status")); }
          else setView(value);
          setErr("");
        } catch (e) { setErr(String((e && e.message) || e)); }
        finally { setBusy(false); }
      }

      const fmt = (ms) => {
        if (!ms) return "—";
        const d = new Date(ms);
        const p = (n) => String(n).padStart(2, "0");
        return (d.getMonth() + 1) + "/" + d.getDate() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
      };

      const codeBody = () => {
        if (!view) return null;
        if (!view.enabled) return jsx("div", { className: "lp_off", children: "登录码未启用（宿主配置 codeLogin: false）" });
        if (!view.active) {
          return jsxs("div", { children: [
            jsx("div", { className: "lp_off", children: "当前没有未使用的登录码" }),
            jsx("button", {
              type: "button", className: "lp_btn", disabled: busy,
              onClick: () => act("issue"), children: busy ? "生成中…" : "生成登录码"
            })
          ] });
        }
        const total = (view.leaseMinutes || 5) * 60;
        const pct = Math.max(0, Math.min(100, (view.secondsLeft / total) * 100));
        return jsxs("div", { children: [
          jsx("div", { className: "lp_code", children: view.code }),
          jsx("div", { className: "lp_bar", children: jsx("i", { className: "lp_barIn", style: { width: pct + "%" } }) }),
          jsx("div", { className: "lp_meta", children: "还剩 " + view.secondsLeft + " 秒 · 用过一次即失效" }),
          jsxs("div", { className: "lp_actions", children: [
            jsx("button", {
              type: "button", className: "lp_btn", disabled: busy,
              onClick: () => act("issue"), children: busy ? "…" : "重新生成"
            }),
            jsx("button", {
              type: "button", className: "lp_btnGhost", disabled: busy,
              onClick: () => act("revoke"), children: "立即作废"
            })
          ] })
        ] });
      };

      const deviceBody = () => {
        if (devices.length === 0) {
          return jsx("div", { className: "lp_off", children: "还没有已授权的设备" });
        }
        return jsxs("div", { children: [
          devices.map((d) => jsxs("div", { className: "lp_dev", key: d.id, children: [
            jsxs("div", { className: "lp_devMain", children: [
              jsx("div", { className: "lp_devName", children: d.label || "未知设备" }),
              jsx("div", { className: "lp_devMeta", children: (d.ip || "—") + " · 授权 " + fmt(d.createdAt) + " · 最近 " + fmt(d.lastSeenAt) })
            ] }),
            jsx("button", {
              type: "button", className: "lp_devBtn", disabled: busy,
              onClick: () => act("revoke-device", { id: d.id }), children: "撤销"
            })
          ] }, d.id)),
          jsx("button", {
            type: "button", className: "lp_btnGhost lp_devAll", disabled: busy,
            onClick: () => act("revoke-all-devices"), children: busy ? "…" : "全部撤销"
          })
        ] });
      };

      return jsxs("li", { className: "lp_card", children: [
        jsxs("div", { className: "lp_header", children: [
          jsx("span", { className: "lp_title", children: "Lan Proxy" }),
          jsx("span", { className: "lp_meta", children: view && view.enabled ? "一次性登录码已启用" : "" })
        ] }),
        jsx("div", { className: "lp_desc", children: "远程设备（非白名单来源）打开 dsh 时需输入此码。码在本机生成，有租期，用一次即作废。" }),
        jsx("div", { className: "lp_body", children: err
          ? jsx("div", { className: "lp_err", children: err })
          : (view === null ? jsx("div", { className: "lp_off", children: "读取中…" }) : codeBody()) }),
        jsxs("div", { className: "lp_body", children: [
          jsxs("div", { className: "lp_sub", children: [
            jsx("span", { children: "已授权设备" }),
            jsx("span", { className: "lp_meta", children: devices.length + " / " + (view && view.maxDevices ? view.maxDevices : 20) })
          ] }),
          deviceBody()
        ] })
      ] });
    }

    function apply(ctx) {
      ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
        name: "settings.plugin.item",
        key: NS,
        inject: () => ({})
      }, LanProxyCard));
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
