## Context

현재 `buildDiffReview` → `renderDiffHtml`는 모든 파일의 diff2html HTML과 전 임베드 파일의 전체 소스(`<script id="source-files-data">`)를 **한 번에** 문서에 박는다. 작은 repo는 문제없지만, 큰 repo는 HTML이 수십 MB가 되어 브라우저 파싱·레이아웃이 메인 스레드를 수 초 점유한다.

실측(`zoobox` HEAD~80, 410 파일):

| 구성 | 크기 |
|---|---|
| 임베드 소스 JSON (`source-files-data`) | 33.4 MB |
| diff2html 테이블 (코드 행 211,583) | 33.8 MB |
| file-state-data | 0.7 MB |
| 기타(diffScript 등) | 8.3 MB |
| **합계** | **76.2 MB** |

소스/렌더 경로: 생성은 `buildDiffReview`(`readUnifiedDiff` → `parseUnifiedDiff` → `renderDiff2Html` → `renderDiffHtml`), 호출자는 `createDiffReview`·`serveDiffWatch`(CLI, browser)·app-main `writeReviewFile`(Electron). 렌더러는 `source-files-data`를 `JSON.parse`해 `sourceByPath`/`sourceFiles`로 보유하고, 캐럿·코멘트·소스뷰·go-to-def가 이를 직접 참조한다.

## Goals / Non-Goals

**Goals**: repo 크기와 무관하게 즉시 열리고 절대 블록되지 않음; 처음부터 모든 단축키 동작; 기존 기능(캐럿·코멘트·머지뷰·go-to-def) 무회귀; 작은 repo·테스트 동작 불변.

**Non-Goals**: diff 알고리즘 변경, 가상 스크롤 라이브러리 도입, 서버 상시 구동(현행 `mo` 모델 유지), 증분 인덱스.

## Decisions

1. **size-conditional 임계.** 총 diff 코드 행 수(혹은 파일 수)가 임계 초과면 지연 모드. 초기값은 실측으로 보정(예: 총 행 > 4000 **또는** 파일 > 60). 임계 이하는 현행 즉시 렌더 경로를 **그대로** 타서 작은 repo·jsdom 회귀가 불변. 메타에 `lazy:true|false`를 실어 렌더러가 분기.

2. **2-페이즈로 분리(저위험 우선).** 프리즈를 먼저 없애고, HTML 축소를 뒤에 둔다.
   - **Phase 1 — 지연 diff 머티리얼라이즈(프리즈 제거, transport 무관, IPC 불필요).** 지연 모드에서 각 파일의 diff2html HTML을 라이브 DOM이 아니라 비활성 `<script type="text/html" id="diff-<i>">` 섬(텍스트)으로 emit. 라이브 DOM에는 가벼운 '접힌 파일 헤더'(경로·뱃지·stats)만. 펼침/`IntersectionObserver` 스크롤 진입 시 `container.innerHTML = island.textContent`로 그 파일만 머티리얼라이즈; 멀어지면 해제해 라이브 행 수 상한. 비활성 텍스트는 211,583 DOM 행/레이아웃을 만들지 않으므로 프리즈가 사라진다. **이 페이즈만으로 "블록 없음 + 단축키 즉시"가 충족**된다(HTML 바이트는 아직 큼).
   - **Phase 2 — 지연 로드로 HTML 축소(80MB→수 MB, IPC/엔드포인트).** diff 섬·소스를 문서에 박지 않고 on-demand로 가져온다.
     - Electron: preload 브리지 + `ipcMain.handle("monacori:get-file", {path, kind})` — app-main이 디스크/`collectSourceFiles` 캐시에서 그 파일의 diff HTML·소스를 반환.
     - browser-serve: `serveDiffWatch`에 `GET /file?path=&kind=diff|source` 라우트 추가(기존 `monacori:http-send` 프록시 패턴과 동일 계열).
     - 렌더러는 머티리얼라이즈/소스뷰 시 브리지(Electron) 또는 `fetch`(serve)로 로드. 두 transport를 같은 렌더러 코드가 `window.monacoriFile?.get ?? fetch(...)`로 흡수.

3. **go-to-def 인덱스 재배치(지연 모드).** 소스가 임베드되지 않으므로 렌더러 Web Worker가 전 소스를 가질 수 없다. 지연 모드에서는 소스를 가진 쪽이 인덱스를 만든다: Electron은 main 프로세스가 빌드 후 `monacori:symbol-index`로 푸시, serve는 `GET /symbol-index`. **비지연 모드는 현행 렌더러 Web Worker 인덱스를 그대로 유지**(이미 구현·검증됨, `symbol-index-nav`). 어느 경우든 인덱스 미도착/미스 시 기존 스캔 폴백 — 단, 지연 모드에선 소스가 메모리에 없을 수 있으니 폴백은 "필요 파일 로드 후 스캔" 또는 "인덱스 대기"로 한정.

4. **지연 모드의 기능 보존(무회귀 핵심).** 캐럿·코멘트·머지뷰·go-to-def는 대상 파일의 diff DOM/소스가 존재한다고 가정한다. 따라서 **특정 파일로 네비게이트/조작하기 직전 그 파일을 머티리얼라이즈·로드 보장**하는 단일 진입점(`ensureFileReady(path)`)을 두고 모든 경로가 이를 거치게 한다. 머지뷰처럼 전 파일을 훑는 기능은 라이브 DOM이 아니라 데이터(코멘트는 `localStorage`, 소스는 필요 시 로드)에서 모으므로 영향 적음.

5. **신선도.** watch 리빌드 시 섬/엔드포인트의 시그니처가 갱신되어 자동 일관. 증분 불필요.

## Risks / Trade-offs

- **머티리얼라이즈 타이밍 vs 기존 코드 가정.** 가장 큰 리스크. `ensureFileReady` 게이트로 일원화하고, 지연 모드 전용 jsdom 테스트(대형 픽스처)로 캐럿/코멘트/go-to-def가 머티리얼라이즈를 트리거하는지 검증.
- **Phase 1만 적용 시 HTML 바이트는 여전히 큼**(다운로드·문자열 메모리). 단 `file://`/로컬이라 다운로드는 즉시이고, 프리즈(레이아웃)는 제거됨 — 사용자 불만(렉·먹통)의 실제 원인은 해소.
- **serve 엔드포인트 보안**: `path`는 repo 루트 화이트리스트(생성 시점 파일 목록)로 제한, 경로 탈출 차단.
- 임계 경계의 repo: 임계만 살짝 넘으면 굳이 지연으로 UX(접힘)만 바뀔 수 있음 → 임계를 넉넉히 잡아 명백히 큰 repo만 지연.

## Migration Plan

추가형 + 분기형. 임계 이하 경로·기존 `Cmd/Ctrl+Down`·캐럿·코멘트·`symbol-index-nav` 워커는 모두 유지. Phase 1 먼저 머지(프리즈 해결) → 검증 후 Phase 2(HTML 축소). 데이터/포맷 마이그레이션 없음. 롤백은 임계를 무한대로 두면 전부 현행.

## Open Questions

- 임계 구체값(행/파일) — Phase 1 적용 후 `zoobox` 등에서 실측 보정.
- 머티리얼라이즈 해제(de-materialize) 도입 여부 — 우선 머티리얼라이즈만, 라이브 노드가 다시 커지면 해제 추가.
- Phase 2에서 diff 섬까지 엔드포인트화할지(완전 축소) vs 소스만 지연(34MB 절반만) — "둘 다(완전 해결)" 선택에 따라 **둘 다 엔드포인트화**가 목표.
