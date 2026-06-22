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

    // Sidebar footer / About
    "sidebar.updateAvailable": "update available",
    "about.title": "About monacori",

    // Review status (toolbar) — units; the numeric count stays dynamic and is prepended at runtime.
    "status.files": "files",
    "status.hunks": "hunks",
    "status.wsIgnored": "ws ignored",
    "status.wsIgnored.title": "Whitespace ignored — Cmd/Ctrl+Shift+W",
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

    // Source toolbar
    "source.title": "Source",
    "source.selectFile": "Select a file from the Files tab.",
    "http.env.title": "HTTP Client environment",
    "http.env.aria": "HTTP environment",
    "btn.diff": "Diff",
    "source.loading": "Loading source…",
    "source.previewUnavailable": "Source preview unavailable.",
    "source.buildingTree": "Building file tree…",

    // Quick open
    "quickopen.aria": "Quick open",
    "quickopen.searchFiles": "Search files",
    "quickopen.recent": "Recent files",
    "quickopen.findInFiles": "Find in Files",
    "quickopen.noFiles": "No files found.",

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
    "settings.checkingUpdates": "Checking for updates…",
    "settings.updateRestart": "Update & Restart",
    "settings.upToDate": "Up to date",
    "settings.updateAvailable": "Update available",
    "settings.updating": "Updating… installing latest, the app will restart",
    "settings.updated": "Updated. Restarting…",
    "settings.updateFailed": "Update failed — try again, or run: npm i -g @happy-nut/monacori",
    "settings.kbd.title": "Keyboard shortcuts",

    // Settings — keyboard-shortcut labels (descriptions only; <kbd> key names stay literal)
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

    // Settings — Merge prompts
    "mergePrompts.title": "Merge prompts",
    "mergePrompts.desc": "Heading prepended to the merged prompt opened with Cmd/Ctrl+Shift+/ (questions) and Cmd/Ctrl+Shift+. (change requests). Leave blank to use the default.",
    "mergePrompts.qHeading": "Questions heading",
    "mergePrompts.cHeading": "Change-requests heading",
    "mergePrompts.reset": "Reset to defaults",
    "settings.saved": "Saved",

    // Composer (per-line question / change-request)
    "composer.question": "Ask a question about this line",
    "composer.changeRequest": "Request a change for this line",
    "composer.save": "Comment",
    "composer.cancel": "Cancel",
    "composer.hint": "Cmd/Ctrl+Enter to save, Esc to cancel",
    "composer.delete": "Delete",
    "comment.kind.q": "❓ Question",
    "comment.kind.c": "✎ Change request",
    "badge.questions": "question(s)",
    "badge.changeRequests": "change request(s)",

    // Merged comments modal
    "merged.qTitle": "Question comments",
    "merged.cTitle": "Change-request comments",
    "merged.copyAll": "Copy all",
    "merged.copied": "Copied",
    "merged.copyFailed": "Copy failed",
    "merged.close": "Close",
    "merged.qHeading": "# Questions",
    "merged.cHeading": "# Change requests",

    // Merge-prompt default agent contracts (these follow the locale — a Korean user gets Korean defaults)
    "mergePrompt.default.q": "The following are questions about code you just wrote. Answer each one — explain the intent, rationale, or context. Do not change any code; this clarifies understanding before any revisions.",
    "mergePrompt.default.c": "The following are change requests for code you just wrote. For each, edit the code at the quoted location to satisfy the request. Keep changes minimal and focused; do not make unrelated edits.",
  },
  ko: {
    // Tabs (sidebar)
    "tab.changes": "변경사항",
    "tab.files": "파일",

    // Sidebar footer / About
    "sidebar.updateAvailable": "업데이트 있음",
    "about.title": "monacori 정보",

    // Review status (toolbar)
    "status.files": "개 파일",
    "status.hunks": "개 헝크",
    "status.wsIgnored": "공백 무시",
    "status.wsIgnored.title": "공백 무시 — Cmd/Ctrl+Shift+W",
    "status.indexed": "개 인덱싱됨",
    "status.index.title": "정의로 이동 인덱스",
    "status.indexing": "인덱싱 중",
    "status.watching": "감시 중",
    "status.live.updated": "실시간: 업데이트됨",
    "status.live.waiting": "실시간: 차이 서버 대기 중",

    // Diff view
    "btn.viewed": "확인함",
    "btn.viewed.title": "확인 표시 토글 (<)",
    "diff.noDiff": "검토할 변경사항이 없습니다.",

    // Source toolbar
    "source.title": "소스",
    "source.selectFile": "파일 탭에서 파일을 선택하세요.",
    "http.env.title": "HTTP 클라이언트 환경",
    "http.env.aria": "HTTP 환경",
    "btn.diff": "변경",
    "source.loading": "소스 불러오는 중…",
    "source.previewUnavailable": "소스 미리보기를 사용할 수 없습니다.",
    "source.buildingTree": "파일 트리 만드는 중…",

    // Quick open
    "quickopen.aria": "빠른 열기",
    "quickopen.searchFiles": "파일 검색",
    "quickopen.recent": "최근 파일",
    "quickopen.findInFiles": "파일 내용 검색",
    "quickopen.noFiles": "파일을 찾을 수 없습니다.",

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
    "settings.checkingUpdates": "업데이트 확인 중…",
    "settings.updateRestart": "업데이트 후 재시작",
    "settings.upToDate": "최신 버전입니다",
    "settings.updateAvailable": "업데이트 있음",
    "settings.updating": "업데이트 중… 최신 버전을 설치하면 앱이 재시작됩니다",
    "settings.updated": "업데이트 완료. 재시작 중…",
    "settings.updateFailed": "업데이트 실패 — 다시 시도하거나 실행하세요: npm i -g @happy-nut/monacori",
    "settings.kbd.title": "키보드 단축키",

    // Settings — keyboard-shortcut labels
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

    // Settings — Merge prompts
    "mergePrompts.title": "병합 프롬프트",
    "mergePrompts.desc": "Cmd/Ctrl+Shift+/ (질문) 및 Cmd/Ctrl+Shift+. (변경요청)로 여는 병합 프롬프트 맨 앞에 붙는 머리말입니다. 비워 두면 기본값을 사용합니다.",
    "mergePrompts.qHeading": "질문 머리말",
    "mergePrompts.cHeading": "변경요청 머리말",
    "mergePrompts.reset": "기본값으로 초기화",
    "settings.saved": "저장됨",

    // Composer
    "composer.question": "이 줄에 대해 질문하기",
    "composer.changeRequest": "이 줄에 대한 변경 요청하기",
    "composer.save": "코멘트",
    "composer.cancel": "취소",
    "composer.hint": "Cmd/Ctrl+Enter로 저장, Esc로 취소",
    "composer.delete": "삭제",
    "comment.kind.q": "❓ 질문",
    "comment.kind.c": "✎ 변경 요청",
    "badge.questions": "개 질문",
    "badge.changeRequests": "개 변경 요청",

    // Merged comments modal
    "merged.qTitle": "질문 코멘트",
    "merged.cTitle": "변경 요청 코멘트",
    "merged.copyAll": "전체 복사",
    "merged.copied": "복사됨",
    "merged.copyFailed": "복사 실패",
    "merged.close": "닫기",
    "merged.qHeading": "# 질문",
    "merged.cHeading": "# 변경 요청",

    // Merge-prompt default agent contracts (Korean default for Korean users)
    "mergePrompt.default.q": "다음은 방금 작성한 코드에 대한 질문입니다. 각 질문에 답하면서 의도, 근거, 맥락을 설명하세요. 코드는 변경하지 마세요. 이 단계는 수정에 앞서 이해를 명확히 하기 위한 것입니다.",
    "mergePrompt.default.c": "다음은 방금 작성한 코드에 대한 변경 요청입니다. 각 요청에 대해 인용된 위치의 코드를 수정하여 요구사항을 충족하세요. 변경은 최소한으로 집중해서 하고, 관련 없는 수정은 하지 마세요.",
  },
};
