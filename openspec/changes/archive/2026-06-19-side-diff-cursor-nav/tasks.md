## 1. diff 캐럿 상태 & 헬퍼

- [x] 1.1 `diffScript()`에 `diffCursor = { path, side, rowIndex, column }` 모듈 상태 추가(`viewerCursor` 옆)
- [x] 1.2 DOM 노드 → `{ side, rowIndex }`을 해석하는 헬퍼(`diffRowInfoFromNode`) 추가(코드 행만, `.d2h-code-line-ctn` 있는 행)
- [x] 1.3 행이 자기 side에서 갖는 인덱스를 반대편 side 테이블의 같은 인덱스 행에 매핑(`moveDiffCursor`의 패널 간 이동에서 구현, `diffRowsOf`는 주입된 코멘트 행 제외)
- [x] 1.4 단어 단위 `<ins>`/`<del>` span을 가로질러 텍스트 노드를 순회하는 diff 셀 캐럿 위치 헬퍼(`diffCaretDomPosition`)

## 2. 캐럿 렌더

- [x] 2.1 활성 `.d2h-code-line-ctn`에 `.code-cursor` 표시 주입(Range.insertNode), 소스 뷰 캐럿 CSS 재사용
- [x] 2.2 `.diff2html-container { caret-color: transparent }`로 네이티브 캐럿 숨김(JS 표시만), 행 강조 `.mc-diff-cursor-row`
- [x] 2.3 파일 전환 시 재적용(`showOnlyFile`→`ensureDiffCursor`, `setActive`도 경유)

## 3. 이동 & 패널 간 건넘

- [x] 3.1 `setDiffCursor(path, side, rowIndex, column, reveal)` — 클램프 + `scrollIntoView`
- [x] 3.2 `moveDiffCursor(dLine, dColumn)` — Up/Down(코드 행만 건너뜀)·Left/Right(칸)
- [x] 3.3 패널 간: new col 0에서 Left → old 정렬 행, old 줄 끝에서 Right → new 정렬 행
- [x] 3.4 빈 placeholder/info 행 안전 처리(코드 행만 안착, column 클램프)
- [x] 3.5 클릭으로 놓기: diff 코드 셀 클릭 시 `diffCursor` 설정(코드 행만)

## 4. keydown 라우팅

- [x] 4.1 `handleDiffCaretKey(event)` — diff 뷰 보임 AND 트리 비포커스 AND 입력 비포커스에서만
- [x] 4.2 document keydown에 연결(소스 캐럿 라우팅 다음), `F7`/`[`/`]`/`Tab` 그대로

## 5. 앵커 연결

- [x] 5.1 `currentCommentTarget`: diff 뷰 + `diffCursor` + 선택 없음 → `(diffCursor.path, 캐럿 줄)`에 앵커
- [x] 5.2 `openDiffFileAtCaret`: `diffCursor`가 있으면 우선 사용

## 6. 검증

- [x] 6.1 `npm run build` + 임베드 `<script>` `node --check`(SYNTAX_OK)
- [x] 6.2 jsdom 하네스: 캐럿 초기화/이동/패널 간 건넘/코멘트 앵커/입력 가드/F7 (diff 캐럿 11/11) + 코멘트 회귀 21/21
- [ ] 6.3 `mo` 시각 스모크: 두 패널 캐럿 표시·패널 간 느낌·이중 캐럿 없음 (실제 Electron 앱 필요 — 미수행)
