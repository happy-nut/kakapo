## Context

테제(`openspec/project.md`): monacori = 리뷰 → 에이전트 프롬프트. 합본 뷰(`openMergedView`/`buildMergedText`)는 이미 종류별 마크다운을 만들고 "Copy all"로 복사한다. 코멘트는 `(path, line, code, text)`를 저장한다(드래그 시 선택 코드까지). IPC는 `monacoriHttp`(preload `contextBridge` → `ipcMain.handle`) 패턴이 이미 있다.

## Goals / Non-Goals

**Goals**: 복사-붙여넣기 없이 전체 리뷰를 에이전트가 읽을 파일로 떨군다. 가볍게(에이전트 프로세스 비소유). 기존 동작 무회귀.

**Non-Goals**: 에이전트 직접 호출/스트리밍/응답 처리(후속 change). 특정 에이전트 CLI에 결합.

## Decisions

1. **파일로 떨군다, 호출하지 않는다.** `.monacori/review-prompt.md`에 전체 리뷰를 쓴다. 사용자가 에이전트에게 그 경로를 가리킨다. 이유: 제1원칙(가볍고 빠르게) + 에이전트 비종속(claude/codex/cursor 무엇이든). spawn 직접 호출은 무거운 후속.
2. **전체 리뷰 한 파일.** 질문 + 수정요청을 한 파일에 두 섹션으로(에이전트가 한 번에 본다) + 짧은 지시 서문.
3. **안정 경로 덮어쓰기.** `.monacori/review-prompt.md` 고정 경로(타임스탬프 없음) — 매번 최신 리뷰. 히스토리는 후속.
4. **IPC는 기존 패턴 재사용.** `monacori:save-prompt`(`ipcMain.handle`) + preload `monacoriReview.savePrompt(md)` → main이 repo 루트의 `.monacori/review-prompt.md`에 쓰고 절대경로 반환. 렌더러는 토스트로 경로 표시.
5. **폴백.** 비-Electron(정적)에선 IPC 부재 → "Copy all" 유지(+ 선택적으로 다운로드).

## Risks / Trade-offs

- 파일 덮어쓰기 → 직전 리뷰 유실(허용; 후속에서 타임스탬프 옵션).
- 사용자가 여전히 에이전트에 한 줄("이 파일 처리해")을 입력 — 의도적(비종속·가벼움). 완전 자동 호출은 별도 후속 change.

## Migration Plan

추가형 변경. 데이터/포맷 마이그레이션 없음. IPC 채널 1개 추가.

## Open Questions

- 프롬프트 서문(에이전트 지시) 정확한 문구?
- 경로 고정 vs 타임스탬프 옵션?
- "Save prompt" 후 자동 에이전트 호출을 별도 후속 change로 둘지?
