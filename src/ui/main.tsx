import { polishNotices, canDismissPolishNotice } from "./polish-notices.ts";
import logo from "../../assets/logo.svg";
import { Icon } from "./Icon.tsx";
import { useReorder } from "./useReorder.ts";
import { LiveEditor, AutoTextarea } from "./LiveEditor.tsx";
import { Markdown } from "./Markdown.tsx";
import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { diffWordsWithSpace } from "diff";
import type { Document, Request, Experience } from "../core/store.ts";
import "./style.css";
import { t, setUiLocale } from "./i18n.ts";
const host = (window as any).h2Host;
function safeStorage(name: "localStorage" | "sessionStorage") {
  const memory = new Map<string, string>();
  try {
    const s = window[name];
    s.getItem("h2-probe");
    return s;
  } catch {
    return {
      getItem: (k: string) => memory.get(k) || null,
      setItem: (k: string, v: string) => {
        memory.set(k, v);
      },
      removeItem: (k: string) => {
        memory.delete(k);
      },
    };
  }
}
const localStorage = safeStorage("localStorage"),
  sessionStorage = safeStorage("sessionStorage");
const fragment = new URLSearchParams(location.hash.slice(1));
const token =
  fragment.get("token") ||
  (location.hash && !location.hash.includes("=")
    ? location.hash.slice(1)
    : "") ||
  localStorage.getItem("h2-token") ||
  sessionStorage.getItem("h2-token") ||
  "";
if (token) {
  localStorage.setItem("h2-token", token);
  sessionStorage.setItem("h2-token", token);
}
if (!host) history.replaceState(null, "", location.pathname);
let activeSessionId =
  host?.sessionId ||
  fragment.get("session") ||
  localStorage.getItem("h2-session") ||
  "";
const docKey = () => "h2-document:" + activeSessionId;
const startupDocumentId = host?.documentId || fragment.get("document");
if (activeSessionId && startupDocumentId)
  localStorage.setItem(docKey(), startupDocumentId);
async function api(path: string, body?: any) {
  if (host) return host.api(path, body, activeSessionId);
  const r = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + token,
      "X-Humanizer-Session": activeSessionId,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    let e;
    try {
      e = (await r.json()).error;
    } catch {}
    throw Object.assign(Error(e || `连接失败 (${r.status})`), {
      status: r.status,
    });
  }
  return r.json();
}
const statusLabel: Record<string, string> = {
  queued: "等待原聊天连接／处理",
  dispatching: "正在发送",
  sent: "原聊天处理中",
  uncertain: "发送结果待确认（不会自动重发）",
  answered: "已回答",
  cancelled: "已取消",
  failed: "失败",
};
type Draft = {
  documentId: string;
  unitId: string;
  text: string;
  revision: number;
};
const draftKey = (d: string, u: string) => "h2-draft:" + d + ":" + u;
function App() {
  const [locale, setLocale] = useState(
      localStorage.getItem("h2-locale") || "zh",
    ),
    [theme, setTheme] = useState(localStorage.getItem("h2-theme") || "dark");
  setUiLocale(locale);
  const [dirtyDocuments, setDirtyDocuments] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("h2-dirty-docs") || "[]");
    } catch {
      return [];
    }
  });
  useEffect(
    () => localStorage.setItem("h2-dirty-docs", JSON.stringify(dirtyDocuments)),
    [dirtyDocuments],
  );
  const chatHistory = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = locale;
  }, [theme, locale]);

  const [state, setState] = useState<any>({
      requests: [],
      documents: [],
      experiences: [],
      sessions: [],
      bridge: {},
    }),
    [sessionId, setSessionId] = useState(activeSessionId),
    [online, setOnline] = useState(false),
    [restoring, setRestoring] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [doc, setDoc] = useState<Document | null>(null),
    [unitId, setUnitId] = useState(""),
    [text, setText] = useState(""),
    [question, setQuestion] = useState(""),
    [sourceMode, setSourceMode] = useState(false),
    [selection, setSelection] = useState(""),
    [selectionText, setSelectionText] = useState(""),
    [selectionRange, setSelectionRange] = useState<
      { from: number; to: number } | undefined
    >(),
    [panel, setPanel] = useState("editor"),
    [confirming, setConfirming] = useState(false),
    [candidates, setCandidates] = useState<any[]>([]),
    [learnId, setLearnId] = useState(""),
    [busy, setBusy] = useState(false),
    [conflict, setConflict] = useState(false),
    [outbox, setOutbox] = useState<any[]>(() => {
      try {
        return JSON.parse(localStorage.getItem("h2-outbox") || "[]");
      } catch {
        return [];
      }
    });
  const [name, setName] = useState(t("未命名.md", "Untitled.md")),
    [importText, setImportText] = useState(""),
    [writingMode, setWritingMode] = useState<"general" | "academic">("general");
  const navigationSequence = useRef(0);
  const [tabMenu, setTabMenu] = useState<{
    kind: "sessions" | "documents";
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const draft = useRef<Draft | null>(null),
    savePromise = useRef<Promise<any> | null>(null),
    docRef = useRef(doc),
    unitRef = useRef(unitId);
  unitRef.current = unitId;
  docRef.current = doc;
  const unit = doc?.units.find((u) => u.id === unitId);
  const requests: Request[] = state.requests.filter(
    (r: Request) => r.documentId === doc?.id,
  );
  const relevant = requests.filter((r) => ["ask", "rewrite"].includes(r.kind));
  const [dismissedPolishNotices, setDismissedPolishNotices] = useState<Set<string>>(() => new Set());
  const initialRequests = polishNotices(requests, dismissedPolishNotices);
  const refresh = async () => {
    try {
      const expectedSession = activeSessionId;
      const expectedNavigation = navigationSequence.current;
      const expectedDocument = docRef.current?.id;
      const sessions = (await api("/sessions")).sessions;
      if (expectedSession !== activeSessionId) return;
      if (
        !activeSessionId ||
        !sessions.some((x: any) => x.id === activeSessionId)
      ) {
        setState((prev: any) => ({ ...prev, sessions }));
        if (sessions.length) {
          activeSessionId = sessions[0].id;
          localStorage.setItem("h2-session", activeSessionId);
          setSessionId(activeSessionId);
        } else setRestoring(false);
        return;
      }
      const nextState = await api("/state");
      if (expectedSession !== activeSessionId) return;
      setState(nextState);
      const current = docRef.current;
      if (
        current &&
        current.id === expectedDocument &&
        expectedNavigation === navigationSequence.current &&
        !nextState.documents.some((d: any) => d.id === current.id)
      ) {
        localStorage.removeItem(docKey());
        docRef.current = null;
        draft.current = null;
        setDoc(null);
        return;
      }
      if (
        current &&
        !draft.current &&
        !savePromise.current &&
        nextState.documents.some(
          (d: any) => d.id === current.id && d.revision !== current.revision,
        )
      ) {
        const updated = await api("/documents/" + current.id);
        if (
          expectedSession === activeSessionId &&
          expectedNavigation === navigationSequence.current &&
          !draft.current &&
          !savePromise.current &&
          docRef.current?.id === current.id
        ) {
          const currentUnit = updated.units.find(
            (u: any) => u.id === unitRef.current,
          );
          if (currentUnit) {
            docRef.current = updated;
            setDoc(updated);
            setText(currentUnit.text);
            setSelection("");
            setSelectionText("");
            setSelectionRange(undefined);
          } else showDocument(updated);
        }
      }
      setOnline(true);
    } catch {
      setOnline(false);
    }
  };
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 2000);
    return () => clearInterval(id);
  }, [sessionId]);
  function showDocument(d: Document, id?: string) {
    setDoc(d);
    docRef.current = d;
    localStorage.setItem(docKey(), d.id);
    const next =
      (id && d.units.some((u) => u.id === id) ? id : undefined) ||
      d.currentUnit ||
      d.units.find((u) => u.editable)?.id ||
      "";
    setUnitId(next);
    unitRef.current = next;
    setQuestion(
      localStorage.getItem("h2-chatdraft:" + d.id + ":" + next) || "",
    );
    const u = d.units.find((u) => u.id === next);
    let saved: Draft | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(draftKey(d.id, next)) || "null");
    } catch {}
    draft.current = saved;
    setText(saved?.text ?? u?.text ?? "");
    setSelection("");
    setSelectionText("");
    setSelectionRange(undefined);
    setConfirming(false);
    setCandidates([]);
    setLearnId("");
    setConflict(false);
    if (saved) setNotice("已恢复未保存的本地草稿；连接恢复后会再次保存。");
  }
  useEffect(() => {
    let cancelled = false;
    setRestoring(true);
    const id = localStorage.getItem(docKey());
    const session = activeSessionId;
    if (id && session)
      loadFullDocument(id)
        .then(async (d) => {
          const unit =
            d.currentUnit || d.units.find((u: any) => u.editable)?.id;
          if (unit) d = await api("/enter", { documentId: d.id, unitId: unit });
          if (!cancelled && session === activeSessionId) showDocument(d);
        })
        .catch((error) => {
          if (!cancelled) setError(error.message);
        })
        .finally(() => {
          if (!cancelled) setRestoring(false);
        });
    else setRestoring(false);
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  async function switchSession(next: string) {
    navigationSequence.current++;
    activeSessionId = next;
    localStorage.setItem("h2-session", next);
    setSessionId(next);
    docRef.current = null;
    draft.current = null;
    setDoc(null);
    setUnitId("");
    unitRef.current = "";
    setQuestion("");
    setError("");
    setNotice("");
    setState((s: any) => ({
      ...s,
      requests: [],
      documents: [],
      history: [],
      threadId: next,
      bridge: {},
    }));
  }
  async function loadFullDocument(id: string) {
    await save();
    const d: Document = await api("/documents/" + id);
    return d;
  }
  async function save(): Promise<Document | null> {
    if (savePromise.current) {
      await savePromise.current;
      return draft.current ? save() : docRef.current;
    }
    if (conflict) throw Error("请先处理段落冲突，草稿已保留");
    const snap = draft.current;
    if (!snap) return docRef.current;
    savePromise.current = (async () => {
      const d: Document = await api("/edit", {
        ...snap,
        documentId: snap.documentId,
        unitId: snap.unitId,
      });
      const u = d.units.find((u) => u.id === snap.unitId)!;
      docRef.current = d;
      setDoc(d);
      if (
        draft.current?.documentId === snap.documentId &&
        draft.current?.unitId === snap.unitId
      ) {
        if (draft.current.text === snap.text) {
          draft.current = null;
          void api("/editing", {
            documentId: snap.documentId,
            unitId: snap.unitId,
            active: false,
          }).catch(() => {});
          localStorage.removeItem(draftKey(snap.documentId, snap.unitId));
          if (!d.units.some((u) => localStorage.getItem(draftKey(d.id, u.id))))
            setDirtyDocuments((ids) => ids.filter((id) => id !== d.id));
          setNotice("已保存");
          setError("");
        } else {
          draft.current = { ...draft.current, revision: u.revision };
          localStorage.setItem(
            draftKey(snap.documentId, snap.unitId),
            JSON.stringify(draft.current),
          );
        }
      }
      return d;
    })();
    try {
      return await savePromise.current;
    } catch (e: any) {
      setNotice("未同步：草稿仍保存在本机");
      if (e.message.includes("其他页面修改")) {
        setConflict(true);
        const latest = await api("/documents/" + snap.documentId);
        setDoc(latest);
        docRef.current = latest;
      }
      throw e;
    } finally {
      savePromise.current = null;
    }
  }
  useEffect(() => {
    const heartbeat = () => {
      const current = docRef.current;
      if (!current) return;
      for (const u of current.units)
        if (localStorage.getItem(draftKey(current.id, u.id)))
          void api("/editing", {
            documentId: current.id,
            unitId: u.id,
            active: true,
          }).catch(() => {});
    };
    const timer = setInterval(heartbeat, 15000);
    return () => clearInterval(timer);
  }, [sessionId]);
  function change(value: string) {
    if (!doc || !unit) return;
    setSelection("");
    setSelectionText("");
    setSelectionRange(undefined);
    const d = {
      documentId: doc.id,
      unitId,
      text: value,
      revision: draft.current?.revision ?? unit.revision,
    };
    if (!draft.current)
      void api("/editing", { documentId: doc.id, unitId, active: true }).catch(
        () => {},
      );
    draft.current = d;
    localStorage.setItem(draftKey(doc.id, unitId), JSON.stringify(d));
    setDirtyDocuments((ids) => (ids.includes(doc.id) ? ids : [...ids, doc.id]));
    setText(value);
    setNotice("");
    if (confirming) setConfirming(false);
    setError("");
  }
  async function run(fn: () => Promise<any>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const sortProps = useReorder(async (group, source, target) => {
    await run(async () => {
      await save();
      await api(`/${group}/reorder`, { source, target });
    });
  }, busy);
  async function ask(kind: string) {
    const d = await save();
    if (!d) return;
    const payload = {
      id: crypto.randomUUID(),
      documentId: d.id,
      unitId: kind === "polish" ? undefined : unitId || undefined,
      selection: kind === "ask" ? selection : undefined,
      selectionText: kind === "ask" ? selectionText : undefined,
      selectionRange: kind === "ask" ? selectionRange : undefined,
      revision: d.revision,
      kind,
      question:
        (["ask", "rewrite"].includes(kind) ? question.trim() : "") ||
        (kind === "polish"
          ? t(
              "请使用适用的中英文规则和已确认偏好润色全文。",
              "Polish the full document using the applicable writing rules and confirmed preferences.",
            )
          : kind === "learn"
            ? t(
                "请从本轮人工修改提炼可迁移的表达偏好；没有则返回空数组。",
                "Extract reusable writing preferences from my edits; return an empty array if there are none.",
              )
            : t(
                "请提出更自然、准确的段落表达。",
                "Suggest more natural and precise wording for this passage.",
              )),
    };
    const pending = [...outbox, { ...payload, boundThread: activeSessionId }];
    setOutbox(pending);
    localStorage.setItem("h2-outbox", JSON.stringify(pending));
    const r = await api("/questions", payload);
    const remaining = pending.filter((x) => x.id !== r.id);
    setOutbox(remaining);
    localStorage.setItem("h2-outbox", JSON.stringify(remaining));
    if (kind === "ask" || kind === "rewrite") {
      localStorage.removeItem("h2-chatdraft:" + d.id + ":" + unitId);
      setQuestion("");
      setSelection("");
      setSelectionText("");
      setSelectionRange(undefined);
    }
    if (kind === "learn") {
      setLearnId(r.id);
      setCandidates((previous) => previous.filter((c) => c.manual));
    }
    setNotice("问题已保存；原聊天连接后自动处理。");
  }
  useEffect(() => {
    const r = state.requests.find((r: Request) => r.id === learnId);
    if (r?.status === "answered" && r.data?.candidates)
      setCandidates((previous) => [
        ...previous.filter((c) => c.manual),
        ...r.data.candidates.map((c: any) => ({
          ...c,
          selected: true,
        })),
      ]);
  }, [learnId, state.requests.find((r: Request) => r.id === learnId)?.status]);
  async function confirm() {
    await save();
    const d = docRef.current!;
    const u = d.units.find((u) => u.id === unitId)!;
    const selected = candidates.filter((c) => c.selected && c.rule.trim());
    const out = await api("/confirm", {
      documentId: d.id,
      unitId,
      revision: u.revision,
      candidates: selected.map(({ rule, language, genre, manual }) => ({
        rule: rule.trim(),
        language,
        genre,
        manual: manual === true,
      })),
      requestId: learnId || undefined,
      syncPreferences: true,
      skipDocumentIds: dirtyDocuments,
    });
    showDocument(out, unitId);
    if (selected.length) {
      setNotice(
        t(
          "经验已保存，已为本会话其他适用文档排队；正在编辑或处理中的文档已跳过。",
          "All preferences saved. Syncing other documents in this session; active edits are preserved.",
        ),
      );
    } else setNotice(t("已完成确认", "Review complete"));
  }
  async function openDocument(id: string) {
    const d = await loadFullDocument(id);
    showDocument(d);
    setPanel("editor");
  }
  async function completeReview() {
    if (!docRef.current || confirming) return;
    const d = await save();
    if (!d) return;
    const u = d.units.find((u) => u.id === unitRef.current);
    setConfirming(true);
    setCandidates([]);
    setLearnId("");
    if (u && u.baseline !== null && u.baseline !== u.text) {
      const pending = state.requests.find(
        (r: Request) =>
          r.kind === "learn" &&
          r.unitId === u.id &&
          r.revision === d.revision &&
          ["queued", "sent", "dispatching"].includes(r.status),
      );
      if (pending) setLearnId(pending.id);
      else await ask("learn");
    }
    if (u) {
      const completed = await api("/review/complete", {
        documentId: d.id,
        unitId: u.id,
        revision: u.revision,
        skipDocumentIds: dirtyDocuments,
      });
      if (docRef.current?.id === d.id && unitRef.current === u.id) {
        docRef.current = completed;
        setDoc(completed);
      }
    }
  }
  const actionRef = useRef({
    save,
    completeReview,
    exportDoc,
    busy,
    doc,
  });
  actionRef.current = { save, completeReview, exportDoc, busy, doc };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.isComposing) {
        const key = e.key.toLowerCase(),
          actions = actionRef.current;
        if (!actions.doc || !["s", "e", "d"].includes(key)) return;
        e.preventDefault();
        if (actions.busy || e.repeat) return;
        void run(
          key === "s"
            ? actions.save
            : key === "e"
              ? actions.exportDoc
              : actions.completeReview,
        );
      }
      if (e.key === "Escape") setTabMenu(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  useEffect(() => {
    const el = chatHistory.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [unitId, relevant.length, relevant.map((r) => r.status).join(",")]);
  async function exportDoc() {
    await save();
    if (host) {
      const out = await api("/export?id=" + encodeURIComponent(doc!.id));
      await host.download(
        out.text,
        doc!.name.replace(/\.(md|txt)$/i, "") + "-润色版." + doc!.format,
      );
      return;
    }
    const r = await fetch("/export?id=" + encodeURIComponent(doc!.id), {
      headers: {
        Authorization: "Bearer " + token,
        "X-Humanizer-Session": activeSessionId,
      },
    });
    if (!r.ok) throw Error("导出失败");
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download =
      doc!.name.replace(/\.(md|txt)$/i, "") + "-润色版." + doc!.format;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="ide" data-theme={theme}>
      <header className="ide-header">
        <div className="brand">
          <img className="brand-logo" src={logo} alt="" />
          <span className="brand-name">
            Humanizer<sup>2</sup>
          </span>
        </div>
        <div className="header-actions">
          <button
            onClick={() =>
              setPanel(panel === "editor" ? "experiences" : "editor")
            }
          >
            {t("表达经验", "Preferences")}
          </button>
          <button
            onClick={() => {
              const next = locale === "zh" ? "en" : "zh";
              setLocale(next);
              setUiLocale(next);
              localStorage.setItem("h2-locale", next);
            }}
            className="icon-button"
            title={t("切换为英文", "Switch to Chinese")}
            aria-label="Language"
          >
            <Icon kind="language" />
          </button>
          <button
            onClick={() => {
              const next = theme === "dark" ? "light" : "dark";
              setTheme(next);
              localStorage.setItem("h2-theme", next);
            }}
            className="icon-button"
            title={
              theme === "dark"
                ? t("切换浅色", "Switch to light")
                : t("切换深色", "Switch to dark")
            }
            aria-label={t("切换主题", "Toggle theme")}
          >
            <Icon kind={theme === "dark" ? "sun" : "moon"} />
          </button>
        </div>
      </header>
      <div
        className="session-tabs"
        role="tablist"
        aria-label={t("会话", "Sessions")}
      >
        {state.sessions.map((s: any) => (
          <button
            role="tab"
            aria-selected={sessionId === s.id}
            key={s.id}
            {...sortProps("sessions", s.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setTabMenu({
                kind: "sessions",
                id: s.id,
                x: Math.min(e.clientX, window.innerWidth - 200),
                y: e.clientY,
              });
            }}
            disabled={busy}
            onClick={() => void run(() => switchSession(s.id))}
          >
            <Icon kind="chat" />
            {s.title}
          </button>
        ))}
        <button
          className="tab-add"
          aria-label={t("新建对话", "New session")}
          disabled={busy || !online}
          onClick={() =>
            void run(async () => {
              if (host?.newSession) await host.newSession();
              else
                await api("/questions", {
                  id: crypto.randomUUID(),
                  kind: "ask",
                  question:
                    "用户点击 Humanizer² 的新建对话按钮。请使用 create_thread 新建一个 Humanizer² 写作聊天，并让新聊天调用 open_bridge 绑定自身以注册到工作台。不要改绑当前会话。完成后回传新建结果。",
                });
              setNotice(
                t("已请求宿主新建对话。", "Requested a new host session."),
              );
            })
          }
        >
          <Icon kind="plus" />
        </button>
      </div>
      {tabMenu && (
        <>
          <div className="menu-dismiss" onClick={() => setTabMenu(null)} />
          <div
            className="context-menu"
            role="menu"
            style={{ left: tabMenu.x, top: tabMenu.y }}
          >
            <button
              role="menuitem"
              disabled={busy}
              onClick={() => {
                const item = tabMenu;
                setTabMenu(null);
                void run(async () => {
                  await save();
                  await api(`/${item.kind}/disconnect`, { id: item.id });
                  if (
                    item.kind === "documents" &&
                    docRef.current?.id === item.id
                  ) {
                    navigationSequence.current++;
                    localStorage.removeItem(docKey());
                    docRef.current = null;
                    draft.current = null;
                    setDoc(null);
                  } else if (
                    item.kind === "sessions" &&
                    activeSessionId === item.id
                  ) {
                    const remaining = (await api("/sessions")).sessions;
                    await switchSession(remaining[0]?.id || "");
                  }
                  setNotice(
                    item.kind === "documents"
                      ? t(
                          "已断开，可从历史文档重新打开。",
                          "Disconnected. Reopen from document history.",
                        )
                      : t(
                          "已断开，请从对应原聊天重新打开工作台以连接。",
                          "Disconnected. Reopen the workbench from its original chat to reconnect.",
                        ),
                  );
                });
              }}
            >
              {t("断开连接", "Disconnect")}
            </button>
          </div>
        </>
      )}
      {error && (
        <div role="alert" className="banner error">
          {t(error)}
          <button onClick={() => setError("")}>×</button>
        </div>
      )}
      {notice && (
        <div role="status" className="banner">
          {t(notice)}
          <button onClick={() => setNotice("")}>×</button>
        </div>
      )}
      {outbox
        .filter((p) => p.boundThread === sessionId)
        .map((p) => (
          <div className="banner warning" key={p.id}>
            {t("问题尚未送达", "Message not delivered")}
            <button
              onClick={() =>
                void run(async () => {
                  await api("/questions", p);
                  const rest = outbox.filter((x) => x.id !== p.id);
                  setOutbox(rest);
                  localStorage.setItem("h2-outbox", JSON.stringify(rest));
                })
              }
            >
              {t("重试", "Retry")}
            </button>
          </div>
        ))}
      <div className="document-layout">
        <aside className="document-sidebar">
          <div className="pane-title">{t("文档", "Documents")}</div>
          <div
            className="document-tabs"
            role="tablist"
            aria-label={t("文档", "Documents")}
            aria-orientation="vertical"
          >
            {state.documents.map((d: any) => (
              <button
                role="tab"
                aria-selected={doc?.id === d.id}
                key={d.id}
                {...sortProps("documents", d.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setTabMenu({
                    kind: "documents",
                    id: d.id,
                    x: Math.min(e.clientX, window.innerWidth - 200),
                    y: e.clientY,
                  });
                }}
                disabled={busy}
                onClick={() => void run(() => openDocument(d.id))}
              >
                <Icon kind="document" />
                <span className="document-name">{d.name}</span>
                {dirtyDocuments.includes(d.id) ? (
                  <span className="dirty-dot">●</span>
                ) : null}
              </button>
            ))}
            <button
              className="tab-add"
              aria-label={t("新增文档", "New document")}
              onClick={() => {
                setDoc(null);
                docRef.current = null;
                draft.current = null;
                setPanel("editor");
              }}
            >
              <Icon kind="plus" />
            </button>
          </div>
        </aside>
        <div className="document-content">
          {panel === "experiences" ? (
            <main className="preferences-page">
              <h2>{t("表达经验", "Preferences")}</h2>
              {state.experiences.map((e: Experience) => (
                <ExperienceCard key={e.id} e={e} run={run} />
              ))}
              {!state.experiences.length && (
                <p>{t("尚无已确认经验", "No confirmed preferences yet")}</p>
              )}
            </main>
          ) : !doc ? (
            <main className="welcome">
              <section className="import">
                <h1>{t("开始一篇新的文档", "Start a new document")}</h1>
                {!!state.history?.length && (
                  <section className="document-history">
                    <h2>{t("历史文档", "Document history")}</h2>
                    <p>
                      {t(
                        "重新打开本会话已有的文档，继续原有修改与对话。",
                        "Reopen this session’s documents with existing edits and conversations.",
                      )}
                    </p>
                    <div className="history-list">
                      {state.history.map((d: any) => (
                        <button
                          key={d.id}
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await api("/documents/attach", { id: d.id });
                              showDocument(await loadFullDocument(d.id));
                              setNotice("");
                            })
                          }
                        >
                          <Icon kind="document" />
                          {d.name}
                        </button>
                      ))}
                    </div>
                  </section>
                )}
                <p>
                  {t(
                    "导入文件或粘贴内容，统一使用 Markdown 编辑。",
                    "Import a file or paste content. All documents use Markdown.",
                  )}
                </p>
                <div className="import-fields">
                  <label>
                    {t("文件名")}
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <label>
                    {t("润色规则")}
                    <select
                      value={writingMode}
                      onChange={(e) =>
                        setWritingMode(e.target.value as "general" | "academic")
                      }
                    >
                      <option value="general">
                        {t("通用写作 · 中英文 humanizer")}
                      </option>
                      <option value="academic">
                        {t("学术写作 · academic-humanizer + 中英文规则")}
                      </option>
                    </select>
                  </label>
                  <label className="file">
                    {t("选择文件")}
                    <input
                      type="file"
                      accept=".md,.markdown,.txt,text/plain,text/markdown"
                      onChange={(e) =>
                        void run(async () => {
                          const f = e.target.files?.[0];
                          if (!f) return;
                          if (f.size > 800000)
                            throw Error("文件过大，首版支持 20 万字符以内");
                          const t = await f.text();
                          setImportText(t);
                          setName(f.name.replace(/\.(txt|markdown)$/i, ".md"));
                        })
                      }
                    />
                  </label>
                </div>
                <AutoTextarea
                  aria-label={t("粘贴原稿")}
                  placeholder={t("在这里粘贴原稿…")}
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                />
                <button
                  className="primary"
                  disabled={
                    restoring ||
                    busy ||
                    !online ||
                    !state.sessions.length ||
                    !importText.trim()
                  }
                  onClick={() =>
                    void run(async () => {
                      const imported = await api("/documents", {
                        name: name.replace(/\.(txt|markdown)$/i, ".md"),
                        text: importText,
                        format: "md",
                        genre: "通用",
                        writingMode,
                      });
                      showDocument(await loadFullDocument(imported.id));
                      setImportText("");
                    })
                  }
                >
                  {t("导入并保留原版")}
                </button>
              </section>
            </main>
          ) : (
            <div className="workspace">
              <section className="review">
                <div className="pane-title">
                  <div className="document-mode">
                    {doc.format !== "txt" ? (
                      <div
                        className="mode-switch"
                        role="group"
                        aria-label={t("编辑模式", "Editor mode")}
                      >
                        <button
                          type="button"
                          aria-pressed={!sourceMode}
                          disabled={confirming}
                          onClick={() => setSourceMode(false)}
                        >
                          {t("预览", "Preview")}
                        </button>
                        <button
                          type="button"
                          aria-pressed={sourceMode}
                          disabled={confirming}
                          onClick={() => setSourceMode(true)}
                        >
                          {t("源码", "Source")}
                        </button>
                      </div>
                    ) : (
                      <span>{t("纯文本", "Plain text")}</span>
                    )}
                  </div>
                  <div className="editor-actions">
                    <button
                      className="action-save"
                      disabled={busy}
                      onClick={() => void run(save)}
                    >
                      {t("保存", "Save")} <kbd>Ctrl S</kbd>
                    </button>
                    <button
                      className="action-complete"
                      disabled={busy || confirming}
                      onClick={() => void run(completeReview)}
                    >
                      {t("完成", "Complete")} <kbd>Ctrl D</kbd>
                    </button>
                    <button
                      className="action-export"
                      disabled={busy}
                      onClick={() => void run(exportDoc)}
                    >
                      {t("导出", "Export")} <kbd>Ctrl E</kbd>
                    </button>
                  </div>
                </div>
                {doc.stage === "imported" && (
                  <button
                    className="first-pass"
                    disabled={
                      busy ||
                      requests.some(
                        (r) =>
                          r.kind === "polish" &&
                          ["queued", "sent", "dispatching"].includes(r.status),
                      )
                    }
                    onClick={() => void run(() => ask("polish"))}
                  >
                    {t("全文润色", "Polish document")}
                  </button>
                )}
                {initialRequests
                  .filter((r) => !r.applied)
                  .map((r) => (
                    <div className="banner" key={r.id}>
                      {t(statusLabel[r.status])}
                      {r.error && t(r.error)}
                      {canDismissPolishNotice(r) && (
                        <button
                          aria-label={t("关闭提示", "Dismiss notice")}
                          onClick={() => setDismissedPolishNotices((ids) => new Set([...ids, r.id]))}
                        >×</button>
                      )}
                    </div>
                  ))}
                {unit ? (
                  <div className="editor-scroll">
                    {conflict && (
                      <div className="warning">
                        {t(
                          "正文已在其他页面改变。草稿已保留，请对照最新内容。",
                          "This document changed elsewhere. Your draft is retained; compare with the latest text.",
                        )}
                        <pre>{unit.text}</pre>
                        <button
                          onClick={() => {
                            if (draft.current)
                              draft.current = {
                                ...draft.current,
                                revision: unit.revision,
                              };
                            setConflict(false);
                          }}
                        >
                          {t("已核对，保留我的编辑", "Compared, keep my edits")}
                        </button>
                      </div>
                    )}
                    {!confirming ? (
                      <LiveEditor
                        key={sessionId + ":" + unitId}
                        value={text}
                        locale={locale}
                        sourceMode={sourceMode}
                        onSourceModeChange={setSourceMode}
                        onChange={change}
                        onSelect={(value) => {
                          if (value) setSelection(value);
                        }}
                        onSelectionText={setSelectionText}
                        onSelectionRange={(range) => {
                          if (range.from !== range.to) setSelectionRange(range);
                        }}
                        plain={doc.format === "txt"}
                      />
                    ) : (
                      <div className="inline-review">
                        <div
                          className="diff"
                          aria-label={t("本轮修改", "Current changes")}
                        >
                          {diffWordsWithSpace(
                            unit.baseline ?? unit.text,
                            unit.text,
                          ).map((p, i) =>
                            p.added ? (
                              <ins key={i}>{p.value}</ins>
                            ) : p.removed ? (
                              <del key={i}>{p.value}</del>
                            ) : (
                              <span key={i}>{p.value}</span>
                            ),
                          )}
                        </div>
                        <button
                          className="text-button"
                          onClick={() => setConfirming(false)}
                        >
                          {t("继续编辑", "Continue editing")}
                        </button>
                        <section className="experience-review">
                          <h3>{t("表达经验", "Writing preferences")}</h3>
                          {learnId &&
                            ["queued", "sent", "dispatching"].includes(
                              state.requests.find(
                                (r: Request) => r.id === learnId,
                              )?.status,
                            ) && (
                              <p>
                                <span className="spinner" />
                                {t(
                                  "正在提炼表达经验…",
                                  "Extracting writing preferences…",
                                )}
                              </p>
                            )}
                          <button
                            className="text-button"
                            onClick={() =>
                              setCandidates((previous) => [
                                ...previous,
                                {
                                  rule: "",
                                  language:
                                    unit.language === "en" ? "en" : "zh",
                                  genre: doc.genre || "通用",
                                  selected: true,
                                  manual: true,
                                },
                              ])
                            }
                          >
                            {t("手动添加经验", "Add preference manually")}
                          </button>
                          <p className="preference-help">
                            {t(
                              "可添加多条，编辑完成后统一保存。添加条目不会开始同步。",
                              "Add and edit multiple preferences, then save them together. Adding entries does not start syncing.",
                            )}
                          </p>
                          {candidates.map((c, i) => (
                            <div className="candidate" key={i}>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={c.selected}
                                  onChange={(e) =>
                                    setCandidates(
                                      candidates.map((x, j) =>
                                        j === i
                                          ? {
                                              ...x,
                                              selected: e.target.checked,
                                            }
                                          : x,
                                      ),
                                    )
                                  }
                                />{" "}
                                {t("保存此经验")}
                              </label>
                              <AutoTextarea
                                aria-label={t("经验候选") + " " + (i + 1)}
                                value={c.rule}
                                onChange={(e) =>
                                  setCandidates(
                                    candidates.map((x, j) =>
                                      j === i
                                        ? { ...x, rule: e.target.value }
                                        : x,
                                    ),
                                  )
                                }
                              />
                              <div className="row">
                                <select
                                  value={c.language}
                                  onChange={(e) =>
                                    setCandidates(
                                      candidates.map((x, j) =>
                                        j === i
                                          ? { ...x, language: e.target.value }
                                          : x,
                                      ),
                                    )
                                  }
                                >
                                  <option value="zh">{t("中文")}</option>
                                  <option value="en">{t("英文")}</option>
                                  <option value="all">{t("全部语言")}</option>
                                </select>
                              </div>
                            </div>
                          ))}

                          <button
                            className="primary save-preferences"
                            disabled={
                              busy ||
                              (!!learnId &&
                                ["queued", "sent", "dispatching"].includes(
                                  state.requests.find(
                                    (r: Request) => r.id === learnId,
                                  )?.status,
                                ))
                            }
                            onClick={() => void run(() => confirm())}
                          >
                            {t(
                              "确认完成并同步其他文档",
                              "Confirm & sync other documents",
                            )}
                          </button>
                        </section>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="empty">
                    {t("请选择文档", "Select a document")}
                  </div>
                )}
              </section>
              <aside className="chat-sidebar">
                <div className="pane-title">
                  <span>{t("对话", "Chat")}</span>
                  <small>{doc.name}</small>
                </div>
                <div className="chat-history" ref={chatHistory}>
                  {relevant.map((r) => (
                    <React.Fragment key={r.id}>
                      <div className="chat-message user">
                        <div className="message-role">{t("你", "You")}</div>
                        {r.selection && (
                          <blockquote className="message-selection">
                            {r.selectionText || r.selection}
                          </blockquote>
                        )}
                        <p>{r.question}</p>
                      </div>
                      <div className="chat-message assistant">
                        <div className="message-role">Agent</div>
                        {r.kind === "ask" && r.answer ? (
                          <Markdown text={r.answer} />
                        ) : r.data?.text ? (
                          <Markdown text={r.data.text} />
                        ) : (
                          <p className="muted">
                            {r.kind === "learn" && r.status === "answered"
                              ? t(
                                  "经验已提取，请在编辑区确认。",
                                  "Preferences extracted. Review them in the editor.",
                                )
                              : t(statusLabel[r.status])}
                          </p>
                        )}
                        {r.error && <p className="warning">{t(r.error)}</p>}
                        {r.status === "answered" &&
                          r.kind === "rewrite" &&
                          !r.applied && (
                            <button
                              disabled={
                                busy ||
                                r.revision !== doc.revision ||
                                !!draft.current
                              }
                              onClick={() =>
                                void run(async () =>
                                  showDocument(
                                    await api("/requests/apply", { id: r.id }),
                                    unitId,
                                  ),
                                )
                              }
                            >
                              {t("采纳建议", "Apply suggestion")}
                            </button>
                          )}
                        {[
                          "queued",
                          "sent",
                          "dispatching",
                          "uncertain",
                        ].includes(r.status) && (
                          <button
                            className="text-button"
                            onClick={() =>
                              void run(() =>
                                api("/requests/cancel", { id: r.id }),
                              )
                            }
                          >
                            {t("取消", "Cancel")}
                          </button>
                        )}
                      </div>
                    </React.Fragment>
                  ))}
                  {!relevant.length && (
                    <div className="chat-empty">
                      {t(
                        "讨论表达、解释修改，或一起改写。",
                        "Discuss wording, explain changes, or rewrite together.",
                      )}
                    </div>
                  )}
                </div>
                {unit && (
                  <div className="chat-composer">
                    {selection && (
                      <div className="selection-preview">
                        <strong>
                          {t("针对选中文字提问", "Ask about selection")}
                        </strong>
                        <blockquote>{selectionText || selection}</blockquote>
                        <button
                          type="button"
                          onClick={() => {
                            setSelection("");
                            setSelectionText("");
                            setSelectionRange(undefined);
                          }}
                        >
                          {t("清除选区", "Clear selection")}
                        </button>
                      </div>
                    )}
                    <AutoTextarea
                      aria-label={t("消息", "Message")}
                      placeholder={t(
                        selection ? "针对选中文字提问…" : "讨论这篇文档…",
                        selection
                          ? "Ask about the selected text…"
                          : "Discuss this document…",
                      )}
                      value={question}
                      onChange={(e) => {
                        setQuestion(e.target.value);
                        localStorage.setItem(
                          "h2-chatdraft:" + doc.id + ":" + unitId,
                          e.target.value,
                        );
                      }}
                      onKeyDown={(e) => {
                        if (
                          e.key === "Enter" &&
                          !e.shiftKey &&
                          !e.nativeEvent.isComposing
                        ) {
                          e.preventDefault();
                          if (question.trim() && !busy)
                            void run(() => ask("ask"));
                        }
                      }}
                    />
                    <div className="composer-actions">
                      <button
                        className="primary"
                        disabled={busy || !question.trim()}
                        onClick={() => void run(() => ask("ask"))}
                      >
                        {t("发送", "Send")} ↑
                      </button>
                    </div>
                  </div>
                )}
              </aside>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ExperienceCard({
  e,
  run,
}: {
  e: Experience;
  run: (fn: () => Promise<any>) => Promise<void>;
}) {
  const [rule, setRule] = useState(e.rule),
    [language, setLanguage] = useState(e.language),
    [deleting, setDeleting] = useState(false);
  return (
    <article className="experience">
      <label>
        {t("表达规则")}
        <AutoTextarea value={rule} onChange={(x) => setRule(x.target.value)} />
      </label>
      <div className="row">
        <select value={language} onChange={(x) => setLanguage(x.target.value)}>
          <option value="zh">{t("中文")}</option>
          <option value="en">{t("英文")}</option>
          <option value="all">{t("全部语言")}</option>
        </select>
        <button
          onClick={() =>
            void run(async () => {
              await api("/experiences/update", {
                id: e.id,
                rule,
                language,
              });
            })
          }
        >
          {t("保存规则")}
        </button>
        <button
          onClick={() =>
            void run(async () => {
              await api("/experiences/update", {
                id: e.id,
                enabled: !e.enabled,
              });
            })
          }
        >
          {e.enabled ? t("禁用") : t("启用")}
        </button>
        <button onClick={() => setDeleting(true)}>{t("删除")}</button>
        {deleting && (
          <>
            <span>{t("删除后不再用于写作。")}</span>
            <button
              onClick={() =>
                void run(async () => {
                  await api("/experiences/delete", { id: e.id });
                })
              }
            >
              {t("确认删除")}
            </button>
            <button onClick={() => setDeleting(false)}>{t("保留")}</button>
          </>
        )}
      </div>
      <details>
        <summary>{t("修改例句与来源")}</summary>
        <p>{t("修改前")}</p>
        <pre>{e.before}</pre>
        <p>{t("修改后")}</p>
        <pre>{e.after}</pre>
        <small>{e.source}</small>
      </details>
    </article>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
