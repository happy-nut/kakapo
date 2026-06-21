## 1. size-conditional 토대

- [x] 1.1 임계 판정(`shouldLazyRender`: 파일 > 60 또는 총 diff 행 > 4000)을 `buildDiffReview`에서 계산해 메타(`review-meta` `data-lazy`)로 전달. 강제 on/off는 환경변수가 아니라 **입력 파라미터**(`buildDiffReview({lazy, lazyLoad})`)로 — serve/Electron이 `lazyLoad:true`, standalone은 미설정(embed). 테스트 픽스처는 `gen.mjs`가 직접 호출로 생성
- [x] 1.2 임계 이하 경로는 현행 즉시 렌더 그대로 — 작은 repo·jsdom 회귀 불변(eager 10스위트 그린, `data-lazy=false`, 섬 0)

## 2. Phase 1 — 지연 diff 머티리얼라이즈(프리즈 제거, IPC 불필요)

- [x] 2.1 `splitDiffForLazy`: 각 파일 diff 본문을 비활성 `<script type="text/html" id="diff-body-N">` 섬으로, 라이브 DOM엔 셸만(`data-path`/`data-first-hunk`/`data-hunk-count`)
- [x] 2.2 `ensureFileReady(wrapper)` (섬→innerHTML, `markWrapperHunks`) + `IntersectionObserver`(600px) 스크롤 머티리얼라이즈 + 첫 파일 즉시
- [x] 2.3 lazy hunk 인덱스(`hunkMeta`)+헬퍼로 F7/change-nav·`setActive`·`showOnlyFile`·`ensureDiffCursor`·tree/quick-open·`showDiffView`가 `ensureFileReady` 경유 → 무회귀
- [ ] 2.4 (옵션, 보류) 멀어진 파일 de-materialize

## 3. Phase 2 — 지연 로드로 HTML 축소 (완료)

### Phase 2a — diff 본문 지연 로드

- [x] 3.2 Electron: `preload.cts` `monacoriFile.get` + `ipcMain "monacori:get-file"`(app-main이 `lazyBodies` 보관)
- [x] 3.3 browser-serve: 빌드 캐시 + `GET /file?index=N`. 렌더러 `window.monacoriFile?.get ?? fetch('file?index=')`(+ `typeof fetch` 가드)
- [x] 3.4 diff 섬 미임베드 → `buildDiffReview`가 `lazyBodies`만 반환. `ensureFileReady` async fetch→`materializeBody`, `whenFileReady`로 네비 정합(동기 경로 무회귀)

### Phase 2b — 소스 지연 로드

- [x] 3.1 소스 일괄 임베드(`source-files-data`) → lazy-LOAD 시 **content 제거(메타데이터만)**. 첫 페인트 후 `loadSourceData`가 소스 블롭 1회 fetch(serve `GET /source-data`, Electron `monacori:get-source-data`)→`sourceByPath`에 content 병합. `openSourceFile`은 미로딩 시 "Loading source…" 후 재오픈
- [x] 3.5 go-to-def 인덱스: **재배치 대신** 소스 블롭 로드 후 기존 렌더러 Web Worker(`startSymbolIndex`)를 실행 — 별도 서버측 인덱스 빌드/IPC 불필요(더 단순). 비지연 모드는 현행 워커 그대로

## 4. 검증

- [x] 4.1 `npm run build`(0) + `node --check`(String.raw 백틱 0 — 로더/소스 코드 포함)
- [x] 4.2 jsdom 회귀 3모드 그린: eager(10) + Phase1-lazy(`gen.mjs lazy`) + lazy-LOAD(`gen.mjs lazyload`)
- [x] 4.3 지연 테스트: `lazy-render.js`(15) + `lazy-load.js`(12 — 섬 0·소스 content strip·async 본문/소스 fetch·nav·F7·소스뷰 지연로딩). serve `/file`·`/source-data` curl 검증
- [x] 4.4(부분) zoobox 실측: HTML **76.7MB(eager) → 37.1MB(2a) → 5.3MB(2b)**. **Electron IPC 경로는 GUI 스모크 필요**(get-file/get-source-data) — 사용자 diff 리뷰 후
