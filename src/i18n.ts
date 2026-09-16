// UI message catalog for the live English / Korean switch.
//
// The viewer ships both languages and switches client-side with NO reload: every translatable
// server-rendered element in render.ts carries data-i18n (textContent), data-i18n-ph (placeholder),
// data-i18n-title (title) or data-i18n-aria (aria-label); applyI18n() in viewer.client.js rewrites
// them, and t(key) feeds the dynamically-built UI. English is the first-paint default.
//
// Keys are stable + dot-namespaced. Excluded by design (NOT translated): diff/code content, file
// paths, syntax-language names, the "kakapo" brand, version strings, and literal <kbd> key names
// (F7, Cmd/Ctrl+B, …). Korean is written for Korean developers — natural, with common technical
// terms left readable (커밋, 탭, 인덱스 …) rather than force-translated.
export const MESSAGES: Record<string, Record<string, string>> = {
  en: {
    // Tabs (sidebar)
    "tab.changes": "Changes",
    "tab.files": "All files",
    "sidebar.switch": "Sidebar tree",
    "tab.changes.title": "Changes (⌘0)",
    "tab.files.title": "All files (⌘1)",
    "tree.markViewed": "Reviewed this file (Space)",
    "rail.branch": "Current branch",
    "brand.revealFile": "Reveal open file in the sidebar (⌥F1)",
    "rail.history": "History",

    // Mermaid diagrams a Markdown body can embed (20-mermaid.js).
    "explain.diagramLoading": "Loading diagram…",
    "diagram.zoom": "Click to enlarge",
    "explain.diagramInvalid": "This diagram could not be rendered.",
    "explain.diagramLoadFailed": "Could not load the diagram renderer.",

    "history.title": "History",
    "history.lineTitle": "Line history",
    "history.search": "Filter by message or author",
    "history.close": "Close",
    "history.empty": "No commits.",
    "history.emptyLine": "No committed history for this line.",
    "history.loading": "Loading…",
    "history.rangeCompare": "Comparing",
    "history.commit": "commit",
    "history.commits": "commits",
    "history.reviewCompare": "Open in review",
    "history.clearRange": "Clear",
    "history.selectHint": "Shift-click (or Shift+↑↓) two commits, then Open in review to compare and comment",
    "goto.placeholder": "Go to line…",
    "goto.copied": "Copied",
    "find.aria": "Find in current file",
    "find.placeholder": "Find in current file",
    "find.previous": "Previous match (Shift+Enter)",
    "find.next": "Next match (Enter)",
    "find.close": "Close (Esc)",
    "find.noResults": "No matches",
    "menu.copyRelativePath": "Copy relative path",
    "menu.copyAbsolutePath": "Copy absolute path",
    "menu.revealFinder": "Show in File Manager",
    "menu.openTerminal": "Open Terminal here",
    // Removes every comment anchored in one file, in one action. Counted, because "clear comments" with no
    // number is a question the menu should have already answered.
    "menu.clearComments": "Clear {n} comments in this file",
    // Shown while the panel waits for tmux to redraw a session that outlived the app. A spinner alone says
    // "something is happening"; this says WHAT, which is the difference between waiting and wondering.
    "notify.agentReplied": "The agent answered a review comment",
    "notify.agentReplies": "The agent answered your review comments",
    "menu.showLineHistory": "Show date and author",
    "menu.hideLineHistory": "Hide date and author",
    // Title on the brand mark while the release image streams down (applyUpdateProgress). The ring on the
    // mark is the report; this is for anyone who wants the number.
    "update.downloading": "Downloading update… {n}%",
    "dock.maximize": "Maximize panel (⌘⇧')",

    // Review status (toolbar) — units; the numeric count stays dynamic and is prepended at runtime.
    "status.watching": "watching",
    "status.live.updated": "Live: updated",
    "status.live.waiting": "Live: waiting for diff server",
    "analysis.idle": "Analysis idle",
    "analysis.starting": "Analysis starting",
    "analysis.ready": "Semantic analysis ready",
    "analysis.fallback": "Heuristic analysis",
    "analysis.failed": "Analysis failed",
    "monaco.peek": "Semantic Peek",
    "monaco.peekHint": "↑/↓ Select · Enter Open · Esc Close",
    "monaco.noResults": "No semantic locations found.",
    "monaco.noSymbol": "No symbol under the caret.",
    "monaco.definitionNotFound": "Definition not found for “{symbol}”.",
    "monaco.referencesNotFound": "No usages found for “{symbol}”.",
    "monaco.implementationNotFound": "Implementation not found for “{symbol}”.",
    "fold.imports": "Imports · {count} lines",
    "fold.block": "{count} folded lines",
    "fold.expand": "Expand folded code",

    // Diff view
    "diff.noDiff": "No diff to review.",
    "changes.empty": "No changed files",
    "diff.lastHunk": "Last change in this file — press F7 again to go to the next file.",
    "diff.navEnd": "No more changes this way.",
    "diag.none": "No language-server problems in this file.",
    "diag.fixComment": "Fix this problem: {message}",
    "diag.fixAdded": "Added a change request to fix this problem.",
    "comment.nav.none": "No comments in this review.",
    "comment.addressed": "possibly addressed",
    "comment.addressed.hint": "The line this comment was anchored to changed in the latest revision — the agent likely addressed it. Reopen if it isn't resolved.",
    "comment.reopen": "Reopen",
    "comment.expandPath": "Show the full path",
    // The agent named a file this workspace does not have — said out loud, because a link that does nothing
    // reads as a broken app (openPathReference).
    "comment.pathMissing": "No such file in this workspace",
    "comment.restored": "Comment restored",
    "comment.restoredMany": "Comments restored",
    "comment.clearedMany": "Cleared {n} comments",
    // Every pane is running something, so there is nowhere to cd without interrupting an agent.
    "diff.previous": "Previous change (Shift+F7)",
    "diff.next": "Next change (F7)",
    "diff.hideSidebar": "Hide changed files",
    "diff.showSidebar": "Show changed files",
    "diff.openSource": "Open source (Cmd/Ctrl+Down)",
    "diff.navigation": "Change navigation",
    "diff.panes": "Diff panes",
    "diff.base": "Base",
    "diff.workingTree": "Working tree",
    // The toolbar pill: what this diff is comparing. `compare.*` matches CompareState["mode"] one for one —
    // the renderer builds the key as `compare.${mode}`, so a new mode needs a row here in every locale.
    "compare.title": "What this diff is comparing",
    "compare.local": "Local changes",
    "compare.staged": "Staged",
    "compare.ahead": "Unpushed",
    "compare.incoming": "Incoming",
    "compare.manual": "Comparing",
    "compare.worktree": "Working tree",
    "compare.index": "Index",
    "compare.incoming.why": "Nothing local to review — showing what the remote is ahead by.",
    "compare.openHistory": "History",
    // The breadcrumb, while the review shows commits: the newest one is named, the rest are counted.
    "compare.andMore": "+{n} more",
    // Compare dropdown on the toolbar pill.
    "compare.menu.aria": "Compare options",
    "compare.menu.all": "All changes",
    "compare.menu.against": "vs {ref}",
    "compare.menu.uncommitted": "Uncommitted changes",
    "compare.menu.target": "Compare against",
    "compare.menu.searchBranch": "Search branches",
    "compare.menu.default": "default",
    "compare.menu.noBranch": "No branch matches",
    "patchset.bar": "Compare base",
    "patchset.base": "Base",
    "patchset.pick": "Choose a patch set to compare against",
    "patchset.pickTarget": "Choose the right side to compare (a patch set, or the working tree)",
    "patchset.exitCompare": "Exit compare (back to working tree)",
    "patchset.target": "Latest",
    "patchset.allShort": "All",
    "patchset.workingTreeShort": "WT",
    "patchset.workingTree": "Working tree",
    "patchset.latest": "latest",
    "patchset.allChanges": "All changes",
    "diff.contextFold": "{count} unchanged lines · expand",
    "diff.contextLoading": "Loading context…",
    "diff.contextUnavailable": "Context could not be loaded.",

    // Source toolbar
    "source.title": "Source",
    "source.selectFile": "Select a file from the Files tab.",
    "source.hiddenTabs": "{count} hidden tabs",
    "http.env.title": "HTTP Client environment",
    "http.env.aria": "HTTP environment",
    "btn.diff": "Diff",
    "btn.diff.title": "Back to diff (F7)",
    "source.loading": "Loading source…",
    "source.previewUnavailable": "Source preview unavailable.",
    "source.viewRaw": "Raw",
    "source.viewRendered": "Rendered",
    "source.lineWrap": "Line wrap",
    "source.lineWrap.title": "Toggle line wrap (Option+W)",
    "source.buildingTree": "Building file tree…",

    // Quick open
    "quickopen.aria": "Quick open",
    "quickopen.searchFiles": "Search files",
    "quickopen.recent": "Recent files",
    "quickopen.findInFiles": "Find in Files",
    "quickopen.extensions": "Extensions",
    "quickopen.extensionsPlaceholder": "All · .py, .ts",
    "quickopen.excludeNoise": "Exclude comments & tests",
    "quickopen.workspaceSymbols": "Workspace symbols",
    "quickopen.noFiles": "No files found.",
    "quickopen.typeToFilter": "type to filter",
    "quickopen.typeFileName": "Type a file name to search.",
    "quickopen.typeToSearch": "Type to search across the project.",
    "quickopen.searching": "Searching…",
    "quickopen.noMatches": "No matches found.",
    "quickopen.results": "results",

    // Usages
    "usages.aria": "Usages",
    "usages.title": "Usages",

    // Agent quota footer

    // Settings — nav
    "settings.aria": "Settings",
    "settings.title": "Settings",
    "settings.cat.general": "General",

    // Settings — General
    "settings.language": "Language",
    "settings.theme": "Theme",
    "settings.uiScale": "Font size",
    "settings.uiScale.hint": "Scales the whole interface, including the terminal.",
    "theme.dark": "Dark",
    "theme.light": "Light",
    // Theme grid: a theme is one named palette that is already light or dark (see renderThemeGrid).
    // "System" is the only automatic entry — it follows the OS with whichever family is currently chosen.
    "theme.name.default-dark": "Kakapo Dark",
    "theme.name.default-light": "Kakapo Light",
    "theme.name.darcula-dark": "Darcula",
    "theme.name.darcula-light": "IntelliJ Light",
    "theme.name.github-dark": "GitHub Dark",
    "theme.name.github-light": "GitHub Light",
    "theme.name.solarized-dark": "Solarized Dark",
    "theme.name.solarized-light": "Solarized Light",
    "theme.name.dracula-dark": "Dracula",
    "theme.name.dracula-light": "Alucard",
    "theme.name.contrast-dark": "High Contrast",
    "theme.name.contrast-light": "High Contrast Light",
    "settings.update": "Update",
    "settings.checkingUpdates": "Checking for updates…",
    "settings.updateRestart": "Update & Restart",
    "settings.upToDate": "Up to date",
    "settings.updateAvailable": "Update available",
    "settings.updating": "Updating… installing latest, the app will restart",
    "settings.updated": "Updated. Restarting…",
    "settings.updateFailed": "Update failed — try again, or run: npm i -g @happy-nut/kakapo",
    "settings.kbd.title": "Keyboard shortcuts",
    "settings.kbd.cat.app": "App",
    "settings.kbd.cat.nav": "Navigation",
    "settings.kbd.cat.editor": "Editor",
    "settings.kbd.cat.review": "Review",
    "settings.kbd.cat.history": "History",

    // Settings — keyboard-shortcut labels (descriptions only; <kbd> key names stay literal)
    "kbd.gotoLine": "Go to line",
    "kbd.rowActions": "Sidebar file actions (path / file manager / terminal)",
    "kbd.openFolder": "Open folder",
    "kbd.openNewWindow": "Open in new window",
    "kbd.openSettings": "Settings",
    "kbd.openHistory": "Open / close Git history",
    "kbd.compareMode": "All changes / uncommitted changes",
    "kbd.compareRef": "Choose the branch to compare against",
    "kbd.closeDialog": "Close dialog / cancel",
    "kbd.sidebarNavigate": "Navigate / open sidebar row",
    "kbd.findNextPrev": "Next / previous match",
    "kbd.pageUpDown": "Page up / down",
    "kbd.runHttp": "Run HTTP request (.http)",
    "kbd.toggleRendered": "Rendered / raw Markdown or CSV",
    "kbd.toggleLineWrap": "Toggle line wrap",
    "kbd.moveCaret": "Move caret",
    "kbd.selectEditor": "Select editor content",
    "kbd.expandDiffFold": "Expand selected diff context",
    "kbd.editComment": "Edit comment (when selected)",
    "kbd.deleteComment": "Delete comment (when selected)",
    "kbd.reviewStops": "Step through comments / folded context",
    "kbd.stepComments": "Step between comments (merged)",
    "kbd.mergedSend": "Comment actions (merged)",
    "kbd.nextChange": "Next change",
    "kbd.prevChange": "Previous change",
    "kbd.nextComment": "Next / previous comment",
    "kbd.closeTab": "Close tab",
    "kbd.prevNextTab": "Prev / next tab",
    "kbd.cursorBackForward": "Cursor back / forward",
    "kbd.findInFile": "Find in current file",
    "kbd.findInFiles": "Find in files",
    "kbd.searchExtensions": "Focus extension filter",
    "kbd.excludeSearchNoise": "Exclude comments / tests",
    "kbd.defUsages": "Definition / usages",
    "kbd.goToImplementation": "Go to implementation",
    "kbd.workspaceSymbol": "Workspace symbol",
    "kbd.goToDef": "Open symbol / source at caret",
    "kbd.toggleFold": "Toggle code fold",
    "kbd.filesChangesTab": "Focus / toggle Files or Changes sidebar",
    "kbd.sidebarContent": "Sidebar ↔ content / switch diff pane",
    "kbd.wordJump": "Word jump (vim w)",
    "kbd.lineStartEnd": "Line start / end",
    "kbd.extendSelection": "Extend selection",
    "kbd.toggleViewed": "Toggle viewed on selected Changes row",
    "kbd.addComment": "Add a review comment",
    "kbd.allComments": "All review comments",
    "kbd.ignoreWhitespace": "Ignore whitespace",
    "kbd.saveComment": "Save comment",
    "kbd.maximizePanel": "Maximize panel (merged / memo)",
    "kbd.historyNavigate": "Select a commit, open it in the review",

    // Settings — Merge prompts

    "trivial.spacing": "spacing",
    "trivial.format": "formatting",
    // The two notes that carry the story of a change: where it goes wrong, and where that is beaten. Louder
    // cards, because a reviewer who reads only two notes should read these two.
    // The card's place in the reading order. Without it the order was real but invisible — the cards sit where
    // the code does, so nothing said which one to open first.

    // The briefing panel (25-briefing.js). The three eyebrows are ours, not the agent's: the shape is fixed,
    // so the note only has to carry the sentence that goes under each one.

    // Shortcut coach (28-shortcut-coach.js) — the top-right nudge that appears when a control with a
    // keyboard shortcut keeps getting clicked, or when a once-used shortcut has gone unused too long.
    "coach.observed": "Here's a useful shortcut for you",
    "coach.rusty": "A shortcut you know has been asleep for {w} weeks",
    "coach.nudgeCount": "reminder {n}/3",
    "coach.gotIt": "Got it",
    "coach.mute": "Don't show this tip again",
    "coach.known": "You already know this one ✓",

    // The knowledge map (⌘⇧K). Its nodes are words the reviewer has used, never words an agent chose, so
    // the empty state says how a word gets in rather than offering a button that would add one.

    // Prompt palette (⌘⇧P)
    // --- Appearance / theme (redesigned settings) ---
    "settings.appearance": "Appearance",
    "settings.cat.shortcuts": "Shortcuts",
    // --- Native application menu ---
    "menu.file": "File",
    "menu.openFolder": "Open Folder…",
    "menu.openNewWindow": "Open in New Window…",
    "menu.view": "View",
    "menu.zoomIn": "Zoom In",
    "menu.zoomOut": "Zoom Out",
    "menu.zoomReset": "Actual Size",
    "menu.review": "Review",
    "menu.allReviewComments": "All review comments",
    "menu.ignoreWhitespace": "Ignore whitespace",
    "menu.window": "Window",
    "menu.closeTab": "Close Tab",
    "menu.closeWindow": "Close Window",
    // --- Native dialogs (quit warning, folder picker, not-a-repo) ---
    "dialog.openRepo.title": "Open a Git repository",
    "dialog.notGit.title": "Not a Git repository",
    "dialog.notGit.message": "{path} is not a Git repository.",
    "welcome.heading": "Review a Git repository",
    "welcome.subtitle": "Pick a folder under Git version control to review its changes.",
    "welcome.openFolder": "Open Folder…",
    "welcome.recentProjects": "Recent projects",
    "welcome.unavailable": "Open Folder is unavailable.",
    "welcome.notGit": "That folder is not a Git repository.",
    "welcome.projectMissing": "That project folder is no longer available.",

    // Composer (one per-line review comment — ask, request a change, or both)
    "composer.comment": "Comment on this line — ask or request a change",
    "composer.save": "Comment",
    "composer.cancel": "Cancel",
    "composer.hint": "⌘Enter to save, Esc to cancel",
    "composer.delete": "Delete",
    "comment.kind": "Comment",
    "badge.comments": "comment(s)",

    // Merged comments modal
    "merged.title": "Review comments",
    "merged.copyAll": "Copy all",
    "merged.allAddressed": "All {n} comments are flagged as possibly addressed, so nothing is left to hand off.",
    "merged.allAnswered": "The agent has answered every open thread. Reply to one of its answers and the reply comes back here.",
    "merged.reopenAll": "Reopen them",
    "merged.copied": "Copied",
    "merged.copyFailed": "Copy failed",
    "merged.close": "Close",

    // One worktree memo (Cmd/Ctrl+Shift+N) — Markdown shortcuts become rich blocks in place.

    // Merge-prompt default agent contracts (these follow the locale — a Korean user gets Korean defaults)
    // Plan contract — prepended to review comments and the prompt memo so every task starts with a small, verifiable plan written to a file.
    "comment.answer": "Answer",

  },
  ko: {
    // Tabs (sidebar)
    "tab.changes": "변경사항",
    "tab.files": "전체 파일",
    "sidebar.switch": "사이드바 트리",
    "tree.markViewed": "이 파일 확인함 (Space)",
    "rail.branch": "현재 브랜치",
    "brand.revealFile": "열린 파일을 사이드바에서 보기 (⌥F1)",
    "rail.history": "히스토리",

    "explain.diagramLoading": "다이어그램을 불러오는 중…",
    "diagram.zoom": "클릭하면 크게 봅니다",
    "explain.diagramInvalid": "이 다이어그램을 그릴 수 없습니다.",
    "explain.diagramLoadFailed": "다이어그램 렌더러를 불러오지 못했습니다.",

    "history.title": "히스토리",
    "history.lineTitle": "라인 히스토리",
    "history.search": "메시지·작성자로 필터",
    "history.close": "닫기",
    "history.empty": "커밋이 없습니다.",
    "history.emptyLine": "이 줄에 연결된 커밋 이력이 없습니다.",
    "history.loading": "불러오는 중…",
    "history.rangeCompare": "비교",
    "history.commit": "커밋",
    "history.commits": "커밋",
    "history.reviewCompare": "리뷰에서 열기",
    "history.clearRange": "해제",
    "history.selectHint": "Shift+클릭(또는 Shift+↑↓)으로 두 커밋 선택 후, '리뷰에서 열기'로 비교·코멘트",
    "goto.placeholder": "이동할 줄 번호…",
    "goto.copied": "복사함",
    "find.aria": "현재 파일에서 찾기",
    "find.placeholder": "현재 파일에서 찾기",
    "find.previous": "이전 결과 (Shift+Enter)",
    "find.next": "다음 결과 (Enter)",
    "find.close": "닫기 (Esc)",
    "find.noResults": "검색 결과 없음",
    "menu.copyRelativePath": "상대 경로 복사",
    "menu.copyAbsolutePath": "절대 경로 복사",
    "menu.revealFinder": "파일 관리자에서 열기",
    "menu.openTerminal": "해당 위치에서 터미널 열기",
    // 한 파일에 달린 코멘트를 한 번에 지운다. 개수를 붙이는 이유는, 숫자 없는 "코멘트 지우기"는
    // 메뉴가 이미 답해줬어야 할 질문을 남기기 때문이다.
    "menu.clearComments": "이 파일의 코멘트 {n}개 지우기",
    "notify.agentReplied": "에이전트가 리뷰 코멘트에 답변했습니다",
    "notify.agentReplies": "에이전트가 리뷰 코멘트들에 답변했습니다",
    "menu.showLineHistory": "날짜와 작성자 표시",
    "menu.hideLineHistory": "날짜와 작성자 숨기기",
    "tab.changes.title": "변경사항 (⌘0)",
    "tab.files.title": "전체 파일 (⌘1)",

    // 레일: 톱니바퀴 배지 툴팁 / 정보
    // 릴리스 이미지를 내려받는 동안 브랜드 마크에 붙는 title (applyUpdateProgress). 링이 곧 보고이고,
    // 이건 숫자를 보고 싶은 사람을 위한 것이다.
    "update.downloading": "업데이트 내려받는 중… {n}%",
    "dock.maximize": "패널 최대화 (⌘⇧')",

    // Review status (toolbar)
    "status.watching": "감시 중",
    "status.live.updated": "실시간: 업데이트됨",
    "status.live.waiting": "실시간: diff 서버 대기 중",
    "analysis.idle": "분석 대기",
    "analysis.starting": "분석 시작 중",
    "analysis.ready": "semantic 분석 준비됨",
    "analysis.fallback": "heuristic 분석",
    "analysis.failed": "분석 실패",
    "monaco.peek": "Semantic Peek",
    "monaco.peekHint": "↑/↓ 선택 · Enter 열기 · Esc 닫기",
    "monaco.noResults": "semantic 위치를 찾지 못했습니다.",
    "monaco.noSymbol": "커서 위치에서 심볼을 찾지 못했습니다.",
    "monaco.definitionNotFound": "“{symbol}”의 정의를 찾지 못했습니다.",
    "monaco.referencesNotFound": "“{symbol}”의 사용 위치를 찾지 못했습니다.",
    "monaco.implementationNotFound": "“{symbol}”의 구현체를 찾지 못했습니다.",
    "fold.imports": "import · {count}줄",
    "fold.block": "코드 {count}줄 접힘",
    "fold.expand": "접힌 코드 펼치기",

    // Diff view
    "diff.noDiff": "검토할 변경사항이 없습니다.",
    "changes.empty": "변경된 파일 없음",
    "diff.lastHunk": "이 파일의 마지막 변경입니다 — F7을 한 번 더 누르면 다음 파일로 이동합니다.",
    "diff.navEnd": "이 방향으로는 더 이상 변경사항이 없습니다.",
    "diag.none": "이 파일에는 언어 서버 문제가 없습니다.",
    "diag.fixComment": "이 문제를 고쳐줘: {message}",
    "diag.fixAdded": "이 문제를 고치는 변경 요청을 추가했습니다.",
    "comment.nav.none": "이 리뷰에는 코멘트가 없습니다.",
    "comment.addressed": "반영된 듯",
    "comment.addressed.hint": "이 코멘트가 가리키던 줄이 최신 변경에서 바뀌었습니다 — 에이전트가 반영했을 가능성이 큽니다. 아직 안 됐으면 재열기하세요.",
    "comment.reopen": "재열기",
    "comment.expandPath": "전체 경로 보기",
    // 에이전트가 이 워크스페이스에 없는 파일을 지목했다 — 아무 반응 없는 링크는 앱이 고장 난 것처럼
    // 보이므로 이유를 말해준다 (openPathReference).
    "comment.pathMissing": "이 워크스페이스에 없는 파일입니다",
    "comment.restored": "코멘트를 복원했습니다",
    "comment.restoredMany": "코멘트들을 복원했습니다",
    "comment.clearedMany": "코멘트 {n}개를 지웠습니다",
    // 모든 pane에서 뭔가 돌고 있어서, 에이전트를 방해하지 않고 cd 할 자리가 없다.
    "diff.previous": "이전 변경 (Shift+F7)",
    "diff.next": "다음 변경 (F7)",
    "diff.hideSidebar": "변경 파일 패널 숨기기",
    "diff.showSidebar": "변경 파일 패널 보이기",
    "diff.openSource": "소스 열기 (Cmd/Ctrl+Down)",
    "diff.navigation": "변경 탐색",
    "diff.panes": "Diff 비교 창",
    "diff.base": "기준 버전",
    "diff.workingTree": "작업 트리",
    "compare.title": "이 diff가 비교하고 있는 대상",
    "compare.local": "로컬 변경",
    "compare.staged": "스테이지",
    "compare.ahead": "안 올린 커밋",
    // "받음"이 아니다 — 이 커밋들은 아직 이 체크아웃에 없다. 바로 위 "안 올린 커밋"과 짝이 되는 반대 방향.
    "compare.incoming": "안 받은 커밋",
    "compare.manual": "비교",
    "compare.worktree": "작업 트리",
    "compare.index": "인덱스",
    "compare.incoming.why": "로컬에 볼 것이 없어, 리모트가 앞서 있는 커밋을 대신 보여주는 중입니다.",
    "compare.openHistory": "히스토리",
    "compare.andMore": "외 {n}개",
    "compare.menu.aria": "비교 옵션",
    "compare.menu.all": "모든 변경사항",
    "compare.menu.against": "{ref} 대비",
    "compare.menu.uncommitted": "커밋되지 않은 변경사항",
    "compare.menu.target": "비교 대상",
    "compare.menu.searchBranch": "브랜치 검색",
    "compare.menu.default": "기본값",
    "compare.menu.noBranch": "일치하는 브랜치 없음",
    "patchset.bar": "기준 비교",
    "patchset.base": "기준",
    "patchset.pick": "비교 기준으로 삼을 patch set 선택",
    "patchset.pickTarget": "비교할 오른쪽 선택 (patch set 또는 작업 트리)",
    "patchset.exitCompare": "비교 종료 (작업 트리로 복귀)",
    "patchset.target": "최신",
    "patchset.allShort": "전체",
    "patchset.workingTreeShort": "작업트리",
    "patchset.workingTree": "작업 트리",
    "patchset.latest": "최신",
    "patchset.allChanges": "전체 변경",
    "diff.contextFold": "변경 없는 {count}줄 · 펼치기",
    "diff.contextLoading": "주변 코드를 불러오는 중…",
    "diff.contextUnavailable": "접힌 코드를 불러오지 못했습니다.",

    // Source toolbar
    "source.title": "소스",
    "source.selectFile": "파일 탭에서 파일을 선택하세요.",
    "source.hiddenTabs": "숨겨진 탭 {count}개",
    "http.env.title": "HTTP 클라이언트 환경",
    "http.env.aria": "HTTP 환경",
    "btn.diff": "Diff",
    "btn.diff.title": "Diff로 돌아가기 (F7)",
    "source.loading": "소스 불러오는 중…",
    "source.previewUnavailable": "소스 미리보기를 사용할 수 없습니다.",
    "source.viewRaw": "원문",
    "source.viewRendered": "렌더링",
    "source.lineWrap": "줄 바꿈",
    "source.lineWrap.title": "긴 줄 줄 바꿈 전환 (Option+W)",
    "source.buildingTree": "파일 트리 만드는 중…",

    // Quick open
    "quickopen.aria": "빠른 열기",
    "quickopen.searchFiles": "파일 검색",
    "quickopen.recent": "최근 파일",
    "quickopen.findInFiles": "파일 내용 검색",
    "quickopen.extensions": "확장자",
    "quickopen.extensionsPlaceholder": "전체 · .py, .ts",
    "quickopen.excludeNoise": "주석·테스트 제외",
    "quickopen.workspaceSymbols": "워크스페이스 심볼",
    "quickopen.noFiles": "파일을 찾을 수 없습니다.",
    "quickopen.typeToFilter": "입력하여 필터",
    "quickopen.typeFileName": "검색할 파일 이름을 입력하세요.",
    "quickopen.typeToSearch": "프로젝트 전체에서 찾을 내용을 입력하세요.",
    "quickopen.searching": "검색 중…",
    "quickopen.noMatches": "일치하는 결과가 없습니다.",
    "quickopen.results": "개 결과",

    // Usages
    "usages.aria": "사용처",
    "usages.title": "사용처",

    // Agent quota footer

    // Settings — nav
    "settings.aria": "설정",
    "settings.title": "설정",
    "settings.cat.general": "일반",

    // Settings — General
    "settings.language": "언어",
    "settings.theme": "테마",
    "settings.uiScale": "글자 크기",
    "settings.uiScale.hint": "터미널을 포함한 인터페이스 전체 크기를 조절합니다.",
    "theme.dark": "다크",
    "theme.light": "라이트",
    // 테마 그리드 — 테마 이름은 고유명사라 번역하지 않고, 밝기 수식어만 한국어로 둡니다.
    "theme.name.default-dark": "Kakapo 다크",
    "theme.name.default-light": "Kakapo 라이트",
    "theme.name.darcula-dark": "Darcula",
    "theme.name.darcula-light": "IntelliJ Light",
    "theme.name.github-dark": "GitHub Dark",
    "theme.name.github-light": "GitHub Light",
    "theme.name.solarized-dark": "Solarized Dark",
    "theme.name.solarized-light": "Solarized Light",
    "theme.name.dracula-dark": "Dracula",
    "theme.name.dracula-light": "Alucard",
    "theme.name.contrast-dark": "고대비 다크",
    "theme.name.contrast-light": "고대비 라이트",
    "settings.update": "업데이트",
    "settings.checkingUpdates": "업데이트 확인 중…",
    "settings.updateRestart": "업데이트 후 재시작",
    "settings.upToDate": "최신 버전입니다",
    "settings.updateAvailable": "업데이트 있음",
    "settings.updating": "업데이트 중… 최신 버전을 설치하면 앱이 재시작됩니다",
    "settings.updated": "업데이트 완료. 재시작 중…",
    "settings.updateFailed": "업데이트 실패 — 다시 시도하거나 실행하세요: npm i -g @happy-nut/kakapo",
    "settings.kbd.title": "키보드 단축키",
    "settings.kbd.cat.app": "앱",
    "settings.kbd.cat.nav": "탐색",
    "settings.kbd.cat.editor": "편집기",
    "settings.kbd.cat.review": "리뷰",
    "settings.kbd.cat.history": "히스토리",

    // Settings — keyboard-shortcut labels
    "kbd.gotoLine": "줄로 이동",
    "kbd.rowActions": "사이드바 파일 작업 (경로 / 파일 관리자 / 터미널)",
    "kbd.openFolder": "폴더 열기",
    "kbd.openNewWindow": "새 창에서 열기",
    "kbd.openSettings": "설정",
    "kbd.openHistory": "Git 히스토리 열기 / 닫기",
    "kbd.compareMode": "모든 변경사항 / 커밋되지 않은 변경사항",
    "kbd.compareRef": "비교할 브랜치 고르기",
    "kbd.closeDialog": "대화상자 닫기 / 취소",
    "kbd.sidebarNavigate": "사이드바 행 이동 / 열기",
    "kbd.findNextPrev": "다음 / 이전 검색 결과",
    "kbd.pageUpDown": "페이지 위 / 아래",
    "kbd.runHttp": "HTTP 요청 실행 (.http)",
    "kbd.toggleRendered": "Markdown·CSV 렌더링 / 원본 전환",
    "kbd.toggleLineWrap": "긴 줄 줄 바꿈 전환",
    "kbd.moveCaret": "커서 이동",
    "kbd.selectEditor": "편집기 내용 전체 선택",
    "kbd.expandDiffFold": "선택한 Diff 접힘 펼치기",
    "kbd.editComment": "코멘트 편집 (선택 시)",
    "kbd.deleteComment": "코멘트 삭제 (선택 시)",
    "kbd.reviewStops": "코멘트 / 접힌 구간 단위 이동",
    "kbd.stepComments": "코멘트 단위 이동 (합본)",
    "kbd.mergedSend": "코멘트 작업 (합본)",
    "kbd.nextChange": "다음 변경",
    "kbd.prevChange": "이전 변경",
    "kbd.nextComment": "다음 / 이전 코멘트",
    "kbd.closeTab": "탭 닫기",
    "kbd.prevNextTab": "이전 / 다음 탭",
    "kbd.cursorBackForward": "커서 뒤로 / 앞으로",
    "kbd.findInFile": "현재 파일에서 찾기",
    "kbd.findInFiles": "파일 내용 찾기",
    "kbd.searchExtensions": "확장자 필터로 이동",
    "kbd.excludeSearchNoise": "주석 / 테스트 검색 결과 제외",
    "kbd.defUsages": "정의 / 사용처",
    "kbd.goToImplementation": "구현체로 이동",
    "kbd.workspaceSymbol": "워크스페이스 심볼",
    "kbd.goToDef": "커서 위치의 심볼 / 소스 열기",
    "kbd.toggleFold": "현재 코드 블록 접기 / 펼치기",
    "kbd.filesChangesTab": "파일 / 변경 사이드바 포커스·토글",
    "kbd.sidebarContent": "사이드바 ↔ 본문 / Diff 패널 전환",
    "kbd.wordJump": "단어 단위 이동 (vim w)",
    "kbd.lineStartEnd": "줄 시작 / 끝",
    "kbd.extendSelection": "선택 영역 확장",
    "kbd.toggleViewed": "선택한 변경 파일의 확인 표시 토글",
    "kbd.addComment": "리뷰 코멘트 달기",
    "kbd.allComments": "전체 리뷰 코멘트",
    "kbd.ignoreWhitespace": "공백 무시",
    "kbd.saveComment": "코멘트 저장",
    "kbd.maximizePanel": "패널 최대화 (합본 / 메모)",
    "kbd.historyNavigate": "커밋 / 파일 선택·열기",

    // Settings — Merge prompts

    "trivial.spacing": "공백",
    "trivial.format": "포맷",

    // 브리핑 말풍선 (25-briefing.js)

    // 단축키 코치 (28-shortcut-coach.js)
    "coach.observed": "유용한 단축키를 알려드릴게요",
    "coach.rusty": "알고 있는 단축키가 {w}주째 잠들어 있어요",
    "coach.nudgeCount": "다시 안내 {n}/3",
    "coach.gotIt": "알겠어요",
    "coach.mute": "이 팁 그만 보기",
    "coach.known": "이미 알고 계시네요 ✓",

    // 지식 그래프 (⌘⇧K)

    // 프롬프트 팔레트 (⌘⇧P)
    // --- Appearance / theme (redesigned settings) ---
    "settings.appearance": "화면",
    "settings.cat.shortcuts": "단축키",
    // --- Native application menu ---
    "menu.file": "파일",
    "menu.openFolder": "폴더 열기…",
    "menu.openNewWindow": "새 창에서 열기…",
    "menu.view": "보기",
    "menu.zoomIn": "확대",
    "menu.zoomOut": "축소",
    "menu.zoomReset": "실제 크기",
    "menu.review": "리뷰",
    "menu.allReviewComments": "모든 리뷰 코멘트",
    "menu.ignoreWhitespace": "공백 무시",
    "menu.window": "창",
    "menu.closeTab": "탭 닫기",
    "menu.closeWindow": "창 닫기",
    // --- Native dialogs (quit warning, folder picker, not-a-repo) ---
    "dialog.openRepo.title": "Git 저장소 열기",
    "dialog.notGit.title": "Git 저장소가 아닙니다",
    "dialog.notGit.message": "{path} 은(는) Git 저장소가 아닙니다.",
    "welcome.heading": "Git 저장소 리뷰",
    "welcome.subtitle": "Git 버전 관리 중인 폴더를 선택해 변경사항을 리뷰하세요.",
    "welcome.openFolder": "폴더 열기…",
    "welcome.recentProjects": "최근 프로젝트",
    "welcome.unavailable": "폴더 열기를 사용할 수 없습니다.",
    "welcome.notGit": "해당 폴더는 Git 저장소가 아닙니다.",
    "welcome.projectMissing": "해당 프로젝트 폴더를 더 이상 사용할 수 없습니다.",

    // Composer
    "composer.comment": "이 줄에 코멘트 남기기 — 질문도 수정 요청도 여기서",
    "composer.save": "코멘트",
    "composer.cancel": "취소",
    "composer.hint": "⌘Enter로 저장, Esc로 취소",
    "composer.delete": "삭제",
    "comment.kind": "코멘트",
    "badge.comments": "개 코멘트",

    // Merged comments modal
    "merged.title": "리뷰 코멘트",
    "merged.copyAll": "전체 복사",
    "merged.allAddressed": "코멘트 {n}개가 모두 반영된 듯으로 표시되어 전달할 내용이 없습니다.",
    "merged.allAnswered": "열린 스레드에 에이전트가 모두 답했습니다. 답변에 답글을 달면 그 답글이 여기로 옵니다.",
    "merged.reopenAll": "다시 열기",
    "merged.copied": "복사됨",
    "merged.copyFailed": "복사 실패",
    "merged.close": "닫기",

    // 워크트리 메모 한 장 (Cmd/Ctrl+Shift+N) — 마크다운 단축 문법이 그 자리에서 서식 블록으로 바뀐다.

    // Merge-prompt default agent contracts (Korean default for Korean users)
    // 플랜 계약문 — 모든 작업이 파일로 작성된 작고 검증 가능한 플랜에서 시작하도록 리뷰 코멘트와 프롬프트 메모 앞에 붙는다.
    // 터미널로 보내는 합본 프롬프트(sendWholeDocToTerminal, 08-dock.js) 맨 앞에 한 번 붙는다 — kakapo가 아래
    // 항목들에 대한 답변 체크리스트를 이미 써둔 경우에만 붙으며, 바로 다음 줄에 절대 경로가 이어진다.
    // kakapo가 문서를 디스크에 저장할 수 있었을 때 터미널로 가는 내용 전부 — 이 한 줄과 절대 경로.
    // 문서(답변 파일 안내 포함)는 그 파일 안에서 기다린다. sendWholeDocToTerminal 참고.
    // 후속 코멘트가 이어받는 이전 대화를 대신한다 (mergedItemLines) — 본문이 아니라 id만. 문서 맨 앞에
    // 적힌 스레드 파일에 전부 들어 있기 때문이다.
    "comment.answer": "답변",

    // Explain 기본 프롬프트 — 에이전트가 diff 위에 붙일 노트 카드를 작성한다. {{NOTES_PATH}}는
    // 보내는 시점에 이 워크스페이스의 주석 파일 경로로 클라이언트에서 치환된다.
  },
};

export type Locale = "en" | "ko";

export function normalizeLocale(value: unknown): Locale {
  return value === "ko" ? "ko" : "en";
}

// Main-process translator: resolves a key for `locale`, falling back to English then the key itself. {tokens}
// are substituted from `vars` when provided — used by the native menu, native dialogs, the workspace rail and
// the welcome screen, whose strings are built in the main process rather than carried by the viewer's data-i18n.
export function makeTranslator(locale: Locale): (key: string, vars?: Record<string, string | number>) => string {
  const table = MESSAGES[locale] || MESSAGES.en;
  return (key, vars) => {
    let text = table && key in table ? table[key] : (MESSAGES.en[key] ?? key);
    if (vars) for (const [name, value] of Object.entries(vars)) text = text.split("{" + name + "}").join(String(value));
    return text;
  };
}
