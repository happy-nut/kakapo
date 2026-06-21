## 1. size-conditional 토대

- [x] 1.1 임계 판정(`shouldLazyRender`: 파일 > 60 또는 총 diff 행 > 4000, `MONACORI_LAZY` 환경변수로 강제 on/off)을 `buildDiffReview`에서 계산해 메타(`review-meta` `data-lazy`)로 렌더러에 전달
- [x] 1.2 임계 이하 경로는 현행 즉시 렌더 그대로(분기 추가만) — 작은 repo·jsdom 회귀 불변 검증(eager 10스위트 그린, `data-lazy=false`, 섬 0)

## 2. Phase 1 — 지연 diff 머티리얼라이즈(프리즈 제거, IPC 불필요)

- [x] 2.1 `splitDiffForLazy`: 각 파일 diff 본문을 비활성 `<script type="text/html" id="diff-body-N">` 섬으로, 라이브 DOM에는 `file-N`+header+빈 `.d2h-files-diff[data-lazy]` 셸만(`data-path`/`data-first-hunk`/`data-hunk-count` 부여)
- [x] 2.2 `ensureFileReady(wrapper)` 단일 진입점(섬→innerHTML, `markWrapperHunks`로 hunk id 부여) + `IntersectionObserver`(600px 마진) 스크롤 머티리얼라이즈 + 첫 파일 즉시 준비
- [x] 2.3 lazy hunk 인덱스(`hunkMeta`)+헬퍼(`hunkTotal/hunkPathAt/hunkRowAt`)로 F7/change-nav·`setActive`·`showOnlyFile`·`ensureDiffCursor`·tree/quick-open·`showDiffView`가 모두 `ensureFileReady` 경유 → 캐럿·코멘트·머지뷰·go-to-def 무회귀
- [ ] 2.4 (옵션, 보류) 라이브 행 수 상한 초과 시 멀어진 파일 de-materialize — Phase 2의 지연 로드와 함께 검토

## 3. Phase 2 — 지연 로드로 HTML 축소(80MB→수 MB)

- [ ] 3.1 소스 일괄 임베드(`source-files-data`) 제거 → 지연 모드에선 미임베드. 소스 뷰 열기 시 on-demand 로드
- [ ] 3.2 Electron: `preload.cts` 브리지 + `ipcMain.handle("monacori:get-file", {path, kind})` — app-main이 diff HTML·소스 반환(경로 화이트리스트)
- [ ] 3.3 browser-serve: `serveDiffWatch`에 `GET /file?path=&kind=diff|source`(+ 경로 탈출 차단). 렌더러는 `window.monacoriFile?.get ?? fetch(...)`로 두 transport 흡수
- [ ] 3.4 diff 섬도 미임베드 → `ensureFileReady`가 로드해서 머티리얼라이즈(완전 축소)
- [ ] 3.5 go-to-def 인덱스: 지연 모드에선 소스 보유 측에서 빌드 → Electron `monacori:symbol-index` 푸시 / serve `GET /symbol-index`. 비지연 모드는 현행 렌더러 Web Worker 유지(`symbol-index-nav`)

## 4. 검증

- [x] 4.1 `npm run build`(0) + 임베드 `<script>` `node --check`(String.raw 백틱 0 — 머티리얼라이즈 코드 포함)
- [x] 4.2 jsdom 회귀(기존 10스위트) eager 그린 + **lazy 강제(`MONACORI_LAZY=1`)에서도 동일 8스위트 그린** — 작은 repo 불변 + 머티리얼라이즈/게이팅 무회귀
- [x] 4.3 지연 모드 jsdom 테스트(`lazy-render.js`, 15 PASS): 초기 라이브 DOM 작음(첫 파일만 머티리얼라이즈, 나머지 lazy) + tree-nav 시 머티리얼라이즈 + 라이브 코드행 생성 + 캐럿 + F7. zoobox 실측: 라이브 diff 행 211,583→첫 파일만, jsdom OOM 해소
- [ ] 4.4 `mo` 스모크(`zoobox`): 즉시 오픈 + 로드 시 블록 없음 + 처음부터 단축키 동작 (수동, GUI)
