/**
 * dsh-lan-proxy 浏览器端 bundle（单文件，经 __ModuleLoader__ 加载）。
 *
 * 向 `settings.general.item` 槽位注册一行「远程登录码」（挂在「设置 → 通用」）：
 * 收起时显示启用状态 + 当前码；展开后是码 + 倒计时 + 生成/作废/重新生成，
 * 以及已授权设备列表（可单台或全部撤销）。
 *
 * 数据通道：`ctx.connection.rpc.call('/api', 'lan-proxy/code', payload)`。
 * dsh 把 /api 的每条请求先过 Host/Origin 栅栏 + cookie 鉴权，因此只有已登录的
 * 会话读得到。宿主侧用 connection.fetch.register 接同一路径（dsh 0.2.2 起
 * exact Fetch 路由由该注册表派发，登录反代也改写不出别的 pathname）。
 */
window.__ModuleLoader__.load({
  id: "dsh-lan-proxy",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const { jsx, jsxs } = require("react/jsx-runtime");

    const name = "dsh-lan-proxy";
    // connection 由 dsh-client-connection 的 client.browser.js provide。
    const inject = ["slots", "locale", "connection"];

    // ── 文案 ────────────────────────────────────────────────────────────────
    // 自带中英双语文案，按 dsh 当前 locale 选（zh* → 中文，其余英文）。
    // 不用宿主 locale 字典：字典注册属 0.2.x 内部约定，升级容易失效。
    const COPY = {
      zh: {
        title: "远程登录码（Lan Proxy）",
        desc: "手机等非白名单设备打开 dsh 时输入此码。码在本机生成，有租期，用一次即作废。",
        enabled: "已启用",
        disabled: "未启用",
        standby: "待生成",
        expand: "展开",
        collapse: "收起",
        off: "登录码未启用（宿主配置 codeLogin: false）",
        none: "当前没有未使用的登录码",
        remaining: (s) => "还剩 " + s + " 秒 · 用过一次即失效",
        issue: "生成登录码",
        reissue: "重新生成",
        revoke: "立即作废",
        issuing: "生成中…",
        devices: "已授权设备",
        devicesEmpty: "还没有已授权的设备",
        revokeOne: "撤销",
        revokeAll: "全部撤销",
        unknownDevice: "未知设备",
        granted: "授权",
        seen: "最近",
        loading: "读取中…",
        failed: "读取失败",
        busy: "…",
        readOnly: "只读",
        remoteNote: "只有部署 dsh 的那一端可以生成、作废或管理登录码；这里不显示码本身。",
      },
      en: {
        title: "Remote login code (Lan Proxy)",
        desc: "Devices outside the whitelist enter this code when opening dsh. Generate it here; it has a lease and works once.",
        enabled: "Enabled",
        disabled: "Disabled",
        standby: "not issued",
        expand: "Expand",
        collapse: "Collapse",
        off: "Login codes are off (host config codeLogin: false)",
        none: "No unused login code",
        remaining: (s) => s + "s left · single use",
        issue: "Generate code",
        reissue: "Regenerate",
        revoke: "Invalidate",
        issuing: "Generating…",
        devices: "Authorized devices",
        devicesEmpty: "No devices have been authorized",
        revokeOne: "Revoke",
        revokeAll: "Revoke all",
        unknownDevice: "Unknown device",
        granted: "granted",
        seen: "last seen",
        loading: "Loading…",
        failed: "Failed to load",
        busy: "…",
        readOnly: "Read-only",
        remoteNote: "Only the machine running dsh can generate, invalidate or manage login codes; the code itself stays hidden here.",
      },
    };

    // ── 样式 ────────────────────────────────────────────────────────────────
    // 只复用 dsh 前端实际定义过的主题令牌（--dsw-alias-*）。
    const cssText =
      ".lp_row{border-bottom:.5px solid var(--dsw-alias-border-l2);padding:16px 0}" +
      ".lp_head{display:flex;align-items:center;justify-content:space-between;gap:16px}" +
      ".lp_headText{min-width:0}" +
      ".lp_title{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}" +
      ".lp_desc{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}" +
      ".lp_headSide{flex:0 0 auto;display:flex;align-items:center;gap:10px}" +
      ".lp_badge{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}" +
      ".lp_toggle{font:inherit;font-size:12px;line-height:18px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}" +
      ".lp_toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
      ".lp_body{margin-top:14px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2)}" +
      ".lp_code{font-size:34px;line-height:44px;font-weight:700;letter-spacing:.22em;font-variant-numeric:tabular-nums;text-align:center;color:var(--dsw-alias-label-primary)}" +
      ".lp_bar{height:4px;border-radius:2px;background:var(--dsw-alias-border-l2);overflow:hidden;margin:10px 0 8px}" +
      ".lp_barIn{display:block;height:100%;background:var(--dsw-alias-brand-primary);transition:width .9s linear}" +
      ".lp_meta{font-size:12px;line-height:18px;text-align:center;color:var(--dsw-alias-label-secondary)}" +
      ".lp_state{font-size:13px;line-height:20px;text-align:center;padding:10px 0;color:var(--dsw-alias-label-secondary)}" +
      ".lp_err{font-size:13px;line-height:20px;text-align:center;padding:10px 0;color:var(--dsw-alias-label-error)}" +
      ".lp_actions{display:flex;gap:8px;margin-top:12px}" +
      ".lp_btn,.lp_btnGhost{flex:1;padding:9px 10px;font:inherit;font-size:13px;font-weight:600;border-radius:9px;cursor:pointer}" +
      ".lp_solo{display:block;width:100%;margin-top:4px}" +
      ".lp_btn{border:0;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff)}" +
      ".lp_btnGhost{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary)}" +
      ".lp_btnGhost:hover:not(:disabled){border-color:var(--dsw-alias-label-error);color:var(--dsw-alias-label-error)}" +
      ".lp_btn:disabled,.lp_btnGhost:disabled{opacity:.55;cursor:default}" +
      ".lp_sub{display:flex;align-items:center;justify-content:space-between;margin:18px 0 4px;font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}" +
      ".lp_dev{display:flex;align-items:center;gap:10px;padding:9px 0;border-top:.5px solid var(--dsw-alias-border-l2)}" +
      ".lp_devMain{flex:1;min-width:0}" +
      ".lp_devName{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".lp_devMeta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".lp_devBtn{flex:0 0 auto;padding:5px 12px;font:inherit;font-size:12px;font-weight:600;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}" +
      ".lp_devBtn:hover:not(:disabled){border-color:var(--dsw-alias-label-error);color:var(--dsw-alias-label-error)}" +
      ".lp_devBtn:disabled{opacity:.55;cursor:default}" +
      ".lp_allBtn{width:100%;margin-top:10px}";
    const tagId = "dsh-lan-proxy/row.css";
    if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-lan-proxy";
      tag.dataset.pluginCss = tagId;
      tag.textContent = cssText;
      document.head.appendChild(tag);
    }

    // 展开时 3 秒刷新；收起时 15 秒（只为头部那一行状态）。
    const POLL_OPEN_MS = 3000;
    const POLL_CLOSED_MS = 15000;

    function formatTime(ms) {
      if (!ms) return "—";
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, "0");
      return (d.getMonth() + 1) + "/" + d.getDate() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }

    function LanProxyRow({ useLocale, connection }) {
      const locale = useLocale((s) => s.active) || "";
      const t = /^zh/i.test(locale) ? COPY.zh : COPY.en;

      const [view, setView] = React.useState(null);
      const [devices, setDevices] = React.useState([]);
      const [err, setErr] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [open, setOpen] = React.useState(false);
      // 远程设备（经反代进来的已授权会话）只读：宿主按请求头判定并回传 remote。
      const remote = !!(view && view.remote);

      const rpc = React.useCallback(async (method, payload) => {
        const result = await connection.rpc.call("/api", "lan-proxy/code", {
          method,
          payload: payload || {},
        });
        if (result && result.ok) return result.value;
        throw new Error((result && result.error && result.error.message) || "RPC failed");
      }, [connection]);

      const refresh = React.useCallback(async () => {
        try {
          const st = await rpc("status");
          // 远程设备拿不到设备表（宿主会拒），不必请求。
          if (open && !(st && st.remote)) {
            const dv = (await rpc("devices")) || {};
            setDevices(dv.devices || []);
          }
          setView(st);
          setErr("");
        } catch (e) {
          setView(null);
          setErr(String((e && e.message) || e));
        }
      }, [rpc, open]);

      React.useEffect(() => {
        let alive = true;
        const tick = () => { if (alive) refresh(); };
        tick();
        const timer = setInterval(tick, open ? POLL_OPEN_MS : POLL_CLOSED_MS);
        return () => { alive = false; clearInterval(timer); };
      }, [refresh, open]);

      async function act(method, payload) {
        setBusy(true);
        try {
          const value = await rpc(method, payload);
          if (value && value.devices) {
            setDevices(value.devices);
            setView(await rpc("status"));
          } else setView(value);
          setErr("");
        } catch (e) { setErr(String((e && e.message) || e)); }
        finally { setBusy(false); }
      }

      // 头部右侧：启用状态 +（有码时）当前码 + 展开/收起
      const statusText = () => {
        if (!view) return "";
        if (!view.enabled) return t.disabled;
        const code = view.active ? view.code : t.standby;
        return remote ? t.readOnly + " · " + code : code;
      };

      const codeBody = () => {
        if (!view.enabled) return jsx("div", { className: "lp_state", children: t.off });
        if (!view.active) {
          return jsxs("div", { children: [
            jsx("div", { className: "lp_state", children: t.none }),
            remote ? jsx("div", { className: "lp_state", children: t.remoteNote }) : jsx("button", {
              type: "button", className: "lp_btn lp_solo", disabled: busy,
              onClick: () => act("issue"), children: busy ? t.issuing : t.issue
            })
          ] });
        }
        const total = (view.leaseMinutes || 5) * 60;
        const pct = Math.max(0, Math.min(100, (view.secondsLeft / total) * 100));
        return jsxs("div", { children: [
          jsx("div", { className: "lp_code", children: view.code }),
          jsx("div", { className: "lp_bar", children: jsx("i", { className: "lp_barIn", style: { width: pct + "%" } }) }),
          jsx("div", { className: "lp_meta", children: t.remaining(view.secondsLeft) }),
          remote ? jsx("div", { className: "lp_state", children: t.remoteNote }) : jsxs("div", { className: "lp_actions", children: [
            jsx("button", {
              type: "button", className: "lp_btn", disabled: busy,
              onClick: () => act("issue"), children: busy ? t.busy : t.reissue
            }),
            jsx("button", {
              type: "button", className: "lp_btnGhost", disabled: busy,
              onClick: () => act("revoke"), children: t.revoke
            })
          ] })
        ] });
      };

      const deviceBody = () => {
        if (devices.length === 0) return jsx("div", { className: "lp_state", children: t.devicesEmpty });
        return jsxs("div", { children: [
          devices.map((d) => jsxs("div", { className: "lp_dev", key: d.id, children: [
            jsxs("div", { className: "lp_devMain", children: [
              jsx("div", { className: "lp_devName", children: d.label || t.unknownDevice }),
              jsx("div", { className: "lp_devMeta", children:
                (d.ip || "—") + " · " + t.granted + " " + formatTime(d.createdAt) + " · " + t.seen + " " + formatTime(d.lastSeenAt) })
            ] }),
            jsx("button", {
              type: "button", className: "lp_devBtn", disabled: busy,
              onClick: () => act("revoke-device", { id: d.id }), children: t.revokeOne
            })
          ] }, d.id)),
          remote ? null : jsx("button", {
            type: "button", className: "lp_btnGhost lp_allBtn", disabled: busy,
            onClick: () => act("revoke-all-devices"), children: busy ? t.busy : t.revokeAll
          })
        ] });
      };

      const expanded = () => {
        if (err) return jsxs("div", { children: [
          jsx("div", { className: "lp_err", children: t.failed + "：" + err }),
          jsx("div", { className: "lp_actions", children: jsx("button", {
            type: "button", className: "lp_btnGhost", onClick: () => refresh(), children: t.loading
          }) })
        ] });
        if (view === null) return jsx("div", { className: "lp_state", children: t.loading });
        // 远程设备只看码的状态；设备表只在部署端展示。
        if (remote) return jsx("div", { children: codeBody() });
        return jsxs("div", { children: [
          codeBody(),
          jsxs("div", { children: [
            jsxs("div", { className: "lp_sub", children: [
              jsx("span", { children: t.devices }),
              jsx("span", { className: "lp_badge", children:
                devices.length + " / " + (view.maxDevices ? view.maxDevices : 20) })
            ] }),
            deviceBody()
          ] })
        ] });
      };

      return jsxs("div", { className: "lp_row", role: "group", "aria-label": t.title, children: [
        jsxs("div", { className: "lp_head", children: [
          jsxs("div", { className: "lp_headText", children: [
            jsx("div", { className: "lp_title", children: t.title }),
            jsx("div", { className: "lp_desc", children: t.desc })
          ] }),
          jsxs("div", { className: "lp_headSide", children: [
            jsx("span", { className: "lp_badge", children: statusText() }),
            jsx("button", {
              type: "button", className: "lp_toggle", "aria-expanded": open,
              onClick: () => setOpen((v) => !v), children: open ? t.collapse : t.expand
            })
          ] })
        ] }),
        open ? jsx("div", { className: "lp_body", children: expanded() }) : null
      ] });
    }

    function apply(ctx) {
      const connection = ctx.get("connection");
      ctx.slots.inject("settings.general.item", () => ctx.slots.register({
        name: "settings.general.item",
        id: "lan-proxy",
        order: 30,
        inject: () => ({ connection, hooks: { locale: ctx.locale } })
      }, LanProxyRow));
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
