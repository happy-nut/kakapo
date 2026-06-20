## 1. 프롬프트 빌더

- [x] 1.1 전체 리뷰(질문 + 수정요청)를 한 마크다운으로 만드는 `buildReviewPrompt()` — 짧은 지시 서문 + 종류별 섹션 + `### file:line` + 캡처 코드 + 코멘트(`buildMergedText` 재사용)

## 2. 파일 쓰기 IPC

- [x] 2.1 `app-main.ts`: `ipcMain.handle('monacori:save-prompt', ...)` — repo 루트의 `.monacori/review-prompt.md`에 마크다운을 쓰고 절대경로 반환
- [x] 2.2 `preload.cts`: `contextBridge`로 `monacoriReview.savePrompt(md): Promise<path>` 노출
- [x] 2.3 `cli.ts`: 합본 뷰에 "Save prompt" 버튼 → `savePromptFile(buildReviewPrompt())` → 저장 경로 표시; IPC 없으면 전체 리뷰 복사로 폴백

## 3. 검증

- [x] 3.1 `npm run build` + 임베드 `<script>`에 `node --check`(String.raw 백틱 함정 — 0개 확인)
- [x] 3.2 jsdom: "Save prompt"가 IPC로 마크다운 전송(모킹) + 경로 표시; 프롬프트에 서문·질문·수정요청·캡처 코드 포함; IPC 부재 시 복사 폴백 — agent-prompt 10/10
- [ ] 3.3 `mo` 스모크: 실제로 `.monacori/review-prompt.md`가 생성되고 에이전트가 읽을 수 있는지(Cmd+Q 재시작 필요 — app-main/preload 변경)
