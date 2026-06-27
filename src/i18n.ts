// UI message catalog for the live English / Korean switch.
//
// The viewer ships both languages and switches client-side with NO reload: every translatable
// server-rendered element in render.ts carries data-i18n (textContent), data-i18n-ph (placeholder),
// data-i18n-title (title) or data-i18n-aria (aria-label); applyI18n() in viewer.client.js rewrites
// them, and t(key) feeds the dynamically-built UI. English is the first-paint default.
//
// Keys are stable + dot-namespaced. Excluded by design (NOT translated): diff/code content, file
// paths, syntax-language names, the "monacori" brand, version strings, and literal <kbd> key names
// (F7, Cmd/Ctrl+B, …). Korean is written for Korean developers — natural, with common technical
// terms left readable (커밋, 탭, 인덱스 …) rather than force-translated.
export const MESSAGES: Record<string, Record<string, string>> = {
  en: {
    // Tabs (sidebar)
    "tab.changes": "Changes",
    "tab.files": "Files",
    "tab.changes.title": "Changes (⌘0)",
    "tab.files.title": "Files (⌘1)",
    "rail.questions": "Questions",
    "rail.changeRequests": "Change requests",
    "rail.branch": "Current branch",

    // Sidebar footer / About
    "sidebar.updateAvailable": "update available",
    "about.title": "About monacori",
    "about.tip": "Settings (⌘,)",
    "terminal.title": "Terminal",
    "terminal.toggle": "Toggle terminal (⌃`)",
    "terminal.close": "Close terminal",
    "dock.maximize": "Maximize panel (⌘⇧')",
    "dock.restore": "Restore panel (⌘⇧')",

    // Review status (toolbar) — units; the numeric count stays dynamic and is prepended at runtime.
    "status.files": "files",
    "status.hunks": "hunks",
    "status.wsIgnored": "ws ignored",
    "status.wsIgnored.title": "Whitespace ignored — ⌘⇧W",
    "status.indexed": "indexed",
    "status.index.title": "Go-to-definition index",
    "status.indexing": "indexing",
    "status.watching": "watching",
    "status.live.updated": "Live: updated",
    "status.live.waiting": "Live: waiting for diff server",

    // Diff view
    "btn.viewed": "Viewed",
    "btn.viewed.title": "Toggle viewed (<)",
    "diff.noDiff": "No diff to review.",
    "diff.lastHunk": "Last change in this file — press F7 again to go to the next file.",

    // Source toolbar
    "source.title": "Source",
    "source.selectFile": "Select a file from the Files tab.",
    "http.env.title": "HTTP Client environment",
    "http.env.aria": "HTTP environment",
    "btn.diff": "Diff",
    "btn.diff.title": "Back to diff (F7)",
    "source.loading": "Loading source…",
    "source.previewUnavailable": "Source preview unavailable.",
    "source.viewRaw": "Raw",
    "source.viewRendered": "Rendered",
    "source.buildingTree": "Building file tree…",

    // Quick open
    "quickopen.aria": "Quick open",
    "quickopen.searchFiles": "Search files",
    "quickopen.recent": "Recent files",
    "quickopen.findInFiles": "Find in Files",
    "quickopen.noFiles": "No files found.",
    "quickopen.typeToFilter": "type to filter",

    // Usages
    "usages.aria": "Usages",
    "usages.title": "Usages",

    // Settings — nav
    "settings.aria": "Settings",
    "settings.title": "Settings",
    "settings.cat.general": "General",
    "settings.cat.prompts": "Merge prompts",

    // Settings — General
    "settings.language": "Language",
    "settings.theme": "Theme",
    "settings.bellNotify": "Notify when a terminal task finishes (bell)",
    "notify.bellBody": "a task finished or needs your input",
    "theme.dark": "Dark",
    "theme.light": "Light",
    "settings.checkingUpdates": "Checking for updates…",
    "settings.updateRestart": "Update & Restart",
    "settings.upToDate": "Up to date",
    "settings.updateAvailable": "Update available",
    "settings.updating": "Updating… installing latest, the app will restart",
    "settings.updated": "Updated. Restarting…",
    "settings.updateFailed": "Update failed — try again, or run: npm i -g @happy-nut/monacori",
    "settings.kbd.title": "Keyboard shortcuts",
    "settings.kbd.cat.app": "App",
    "settings.kbd.cat.nav": "Navigation",
    "settings.kbd.cat.review": "Review",
    "settings.kbd.cat.terminal": "Terminal",

    // Settings — keyboard-shortcut labels (descriptions only; <kbd> key names stay literal)
    "kbd.openFolder": "Open folder",
    "kbd.openNewWindow": "Open in new window",
    "kbd.openSettings": "Settings",
    "kbd.closeDialog": "Close dialog / cancel",
    "kbd.pageUpDown": "Page up / down",
    "kbd.runHttp": "Run HTTP request (.http)",
    "kbd.editComment": "Edit comment (when selected)",
    "kbd.deleteComment": "Delete comment (when selected)",
    "kbd.stepComments": "Step between comments (merged)",
    "kbd.mergedSend": "Comment menu / send to pane (merged)",
    "kbd.nextChange": "Next change",
    "kbd.prevChange": "Previous change",
    "kbd.closeTab": "Close tab",
    "kbd.prevNextTab": "Prev / next tab",
    "kbd.cursorBackForward": "Cursor back / forward",
    "kbd.findFile": "Find file",
    "kbd.findInFiles": "Find in files",
    "kbd.recentFiles": "Recent files",
    "kbd.defUsages": "Definition / usages",
    "kbd.goToDef": "Go to definition",
    "kbd.filesChangesTab": "Files / Changes tab",
    "kbd.sidebarContent": "Sidebar ↔ content",
    "kbd.wordJump": "Word jump (vim w)",
    "kbd.lineStartEnd": "Line start / end",
    "kbd.extendSelection": "Extend selection",
    "kbd.toggleViewed": "Toggle viewed",
    "kbd.addQuestionChange": "Add question / change",
    "kbd.allQuestionsChanges": "All questions / changes",
    "kbd.ignoreWhitespace": "Ignore whitespace",
    "kbd.saveComment": "Save comment",
    "kbd.promptMemo": "Prompt memo",
    "kbd.maximizePanel": "Maximize panel (terminal / merged / memo)",
    "kbd.toggleTerminal": "Toggle terminal",
    "kbd.splitPane": "Split pane",
    "kbd.focusPane": "Focus prev / next pane",
    "kbd.renamePane": "Rename pane",
    "kbd.closeTerminal": "Close terminal (when focused)",

    // Settings — Merge prompts
    "mergePrompts.title": "Merge prompts",
    "mergePrompts.desc": "Heading prepended to the merged prompt opened with ⌘⇧/ (questions) and ⌘⇧. (change requests). Leave blank to use the default.",
    "mergePrompts.qHeading": "Questions heading",
    "mergePrompts.cHeading": "Change-requests heading",
    "mergePrompts.reset": "Reset to defaults",
    "settings.saved": "Saved",

    // Composer (per-line question / change-request)
    "composer.question": "Ask a question about this line",
    "composer.changeRequest": "Request a change for this line",
    "composer.save": "Comment",
    "composer.cancel": "Cancel",
    "composer.hint": "⌘Enter to save, Esc to cancel",
    "composer.delete": "Delete",
    "comment.kind.q": "❓ Question",
    "comment.kind.c": "✎ Change request",
    "badge.questions": "question(s)",
    "badge.changeRequests": "change request(s)",

    // Merged comments modal
    "merged.qTitle": "Question comments",
    "merged.cTitle": "Change-request comments",
    "merged.copyAll": "Copy all",
    "merged.sendToTerminal": "Send to terminal",
    "merged.copied": "Copied",
    "merged.copyFailed": "Copy failed",
    "merged.close": "Close",
    "dropdown.navigate": "Go to comment",
    "dropdown.remove": "Remove",
    "merged.qHeading": "# Questions",
    "merged.cHeading": "# Change requests",

    // Prompt memo (Cmd/Ctrl+Shift+N) — a single freeform Markdown scratchpad with a live split preview.
    "memo.title": "Prompt memo",
    "memo.placeholder": "Jot down what you're planning, in Markdown…",
    "memo.previewEmpty": "Markdown preview shows up here as you type.",

    // Merge-prompt default agent contracts (these follow the locale — a Korean user gets Korean defaults)
    "mergePrompt.default.q": "The following are questions about code you just wrote. Answer each one — explain the intent, rationale, or context. Do not change any code; this clarifies understanding before any revisions.",
    "mergePrompt.default.c": "The following are change requests for code you just wrote. For each, edit the code at the quoted location to satisfy the request. Keep changes minimal and focused; do not make unrelated edits.",
  },
  ko: {
    // Tabs (sidebar)
    "tab.changes": "변경사항",
    "tab.files": "파일",
    "rail.questions": "질문",
    "rail.changeRequests": "변경 요청",
    "rail.branch": "현재 브랜치",
    "tab.changes.title": "변경사항 (⌘0)",
    "tab.files.title": "파일 (⌘1)",

    // Sidebar footer / About
    "sidebar.updateAvailable": "업데이트 있음",
    "about.title": "monacori 정보",
    "about.tip": "설정 (⌘,)",
    "terminal.title": "터미널",
    "terminal.toggle": "터미널 토글 (⌃`)",
    "terminal.close": "터미널 닫기",
    "dock.maximize": "패널 최대화 (⌘⇧')",
    "dock.restore": "패널 복원 (⌘⇧')",

    // Review status (toolbar)
    "status.files": "개 파일",
    "status.hunks": "개 변경 묶음",
    "status.wsIgnored": "공백 무시",
    "status.wsIgnored.title": "공백 무시 — ⌘⇧W",
    "status.indexed": "개 인덱싱됨",
    "status.index.title": "정의로 이동 인덱스",
    "status.indexing": "인덱싱 중",
    "status.watching": "감시 중",
    "status.live.updated": "실시간: 업데이트됨",
    "status.live.waiting": "실시간: diff 서버 대기 중",

    // Diff view
    "btn.viewed": "확인함",
    "btn.viewed.title": "확인 표시 토글 (<)",
    "diff.noDiff": "검토할 변경사항이 없습니다.",
    "diff.lastHunk": "이 파일의 마지막 변경입니다 — F7을 한 번 더 누르면 다음 파일로 이동합니다.",

    // Source toolbar
    "source.title": "소스",
    "source.selectFile": "파일 탭에서 파일을 선택하세요.",
    "http.env.title": "HTTP 클라이언트 환경",
    "http.env.aria": "HTTP 환경",
    "btn.diff": "Diff",
    "btn.diff.title": "Diff로 돌아가기 (F7)",
    "source.loading": "소스 불러오는 중…",
    "source.previewUnavailable": "소스 미리보기를 사용할 수 없습니다.",
    "source.viewRaw": "원문",
    "source.viewRendered": "렌더링",
    "source.buildingTree": "파일 트리 만드는 중…",

    // Quick open
    "quickopen.aria": "빠른 열기",
    "quickopen.searchFiles": "파일 검색",
    "quickopen.recent": "최근 파일",
    "quickopen.findInFiles": "파일 내용 검색",
    "quickopen.noFiles": "파일을 찾을 수 없습니다.",
    "quickopen.typeToFilter": "입력하여 필터",

    // Usages
    "usages.aria": "사용처",
    "usages.title": "사용처",

    // Settings — nav
    "settings.aria": "설정",
    "settings.title": "설정",
    "settings.cat.general": "일반",
    "settings.cat.prompts": "병합 프롬프트",

    // Settings — General
    "settings.language": "언어",
    "settings.theme": "테마",
    "settings.bellNotify": "터미널 작업이 끝나면 알림 (벨)",
    "notify.bellBody": "작업이 끝났거나 입력이 필요합니다",
    "theme.dark": "다크",
    "theme.light": "라이트",
    "settings.checkingUpdates": "업데이트 확인 중…",
    "settings.updateRestart": "업데이트 후 재시작",
    "settings.upToDate": "최신 버전입니다",
    "settings.updateAvailable": "업데이트 있음",
    "settings.updating": "업데이트 중… 최신 버전을 설치하면 앱이 재시작됩니다",
    "settings.updated": "업데이트 완료. 재시작 중…",
    "settings.updateFailed": "업데이트 실패 — 다시 시도하거나 실행하세요: npm i -g @happy-nut/monacori",
    "settings.kbd.title": "키보드 단축키",
    "settings.kbd.cat.app": "앱",
    "settings.kbd.cat.nav": "탐색",
    "settings.kbd.cat.review": "리뷰",
    "settings.kbd.cat.terminal": "터미널",

    // Settings — keyboard-shortcut labels
    "kbd.openFolder": "폴더 열기",
    "kbd.openNewWindow": "새 창에서 열기",
    "kbd.openSettings": "설정",
    "kbd.closeDialog": "대화상자 닫기 / 취소",
    "kbd.pageUpDown": "페이지 위 / 아래",
    "kbd.runHttp": "HTTP 요청 실행 (.http)",
    "kbd.editComment": "코멘트 편집 (선택 시)",
    "kbd.deleteComment": "코멘트 삭제 (선택 시)",
    "kbd.stepComments": "코멘트 단위 이동 (합본)",
    "kbd.mergedSend": "코멘트 메뉴 / 패널로 전송 (합본)",
    "kbd.nextChange": "다음 변경",
    "kbd.prevChange": "이전 변경",
    "kbd.closeTab": "탭 닫기",
    "kbd.prevNextTab": "이전 / 다음 탭",
    "kbd.cursorBackForward": "커서 뒤로 / 앞으로",
    "kbd.findFile": "파일 찾기",
    "kbd.findInFiles": "파일 내용 찾기",
    "kbd.recentFiles": "최근 파일",
    "kbd.defUsages": "정의 / 사용처",
    "kbd.goToDef": "정의로 이동",
    "kbd.filesChangesTab": "파일 / 변경사항 탭",
    "kbd.sidebarContent": "사이드바 ↔ 본문",
    "kbd.wordJump": "단어 단위 이동 (vim w)",
    "kbd.lineStartEnd": "줄 시작 / 끝",
    "kbd.extendSelection": "선택 영역 확장",
    "kbd.toggleViewed": "확인 표시 토글",
    "kbd.addQuestionChange": "질문 / 변경요청 추가",
    "kbd.allQuestionsChanges": "전체 질문 / 변경요청",
    "kbd.ignoreWhitespace": "공백 무시",
    "kbd.saveComment": "코멘트 저장",
    "kbd.promptMemo": "프롬프트 메모",
    "kbd.maximizePanel": "패널 최대화 (터미널 / 합본 / 메모)",
    "kbd.toggleTerminal": "터미널 토글",
    "kbd.splitPane": "패널 분할",
    "kbd.focusPane": "이전 / 다음 패널로 이동",
    "kbd.renamePane": "패널 이름 변경",
    "kbd.closeTerminal": "터미널 닫기 (포커스 시)",

    // Settings — Merge prompts
    "mergePrompts.title": "병합 프롬프트",
    "mergePrompts.desc": "⌘⇧/ (질문) 및 ⌘⇧. (변경요청)로 여는 병합 프롬프트 맨 앞에 붙는 머리말입니다. 비워 두면 기본값을 사용합니다.",
    "mergePrompts.qHeading": "질문 머리말",
    "mergePrompts.cHeading": "변경요청 머리말",
    "mergePrompts.reset": "기본값으로 초기화",
    "settings.saved": "저장됨",

    // Composer
    "composer.question": "이 줄에 대해 질문하기",
    "composer.changeRequest": "이 줄에 대한 변경 요청하기",
    "composer.save": "코멘트",
    "composer.cancel": "취소",
    "composer.hint": "⌘Enter로 저장, Esc로 취소",
    "composer.delete": "삭제",
    "comment.kind.q": "❓ 질문",
    "comment.kind.c": "✎ 변경 요청",
    "badge.questions": "개 질문",
    "badge.changeRequests": "개 변경 요청",

    // Merged comments modal
    "merged.qTitle": "질문 코멘트",
    "merged.cTitle": "변경 요청 코멘트",
    "merged.copyAll": "전체 복사",
    "merged.sendToTerminal": "터미널로 전송",
    "merged.copied": "복사됨",
    "merged.copyFailed": "복사 실패",
    "merged.close": "닫기",
    "dropdown.navigate": "코멘트로 이동",
    "dropdown.remove": "지우기",
    // Structural markers stay English in both locales (the preamble prose below follows the locale).
    "merged.qHeading": "# Questions",
    "merged.cHeading": "# Change requests",

    // 프롬프트 메모 (Cmd/Ctrl+Shift+N) — 라이브 분할 미리보기가 있는 자유 형식 마크다운 메모 한 장.
    "memo.title": "프롬프트 메모",
    "memo.placeholder": "구상 중인 것을 마크다운으로 적어 보세요…",
    "memo.previewEmpty": "입력하면 여기에 마크다운 미리보기가 나타납니다.",

    // Merge-prompt default agent contracts (Korean default for Korean users)
    "mergePrompt.default.q": "다음은 방금 작성한 코드에 대한 질문입니다. 각 질문에 답하면서 의도, 근거, 맥락을 설명하세요. 코드는 변경하지 마세요. 이 단계는 수정에 앞서 이해를 명확히 하기 위한 것입니다.",
    "mergePrompt.default.c": "다음은 방금 작성한 코드에 대한 변경 요청입니다. 각 요청에 대해 인용된 위치의 코드를 수정하여 요구사항을 충족하세요. 변경은 최소한으로 집중해서 하고, 관련 없는 수정은 하지 마세요.",
  },
};
