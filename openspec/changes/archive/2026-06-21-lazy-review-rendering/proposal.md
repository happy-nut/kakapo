## Why

큰 repo를 열면 UI가 수 초간 멈추고 단축키가 전혀 안 먹는다. 원인은 생성된 리뷰 HTML 자체가 거대하기 때문이다 — `zoobox` HEAD~80(410 파일) 실측: **80MB HTML = 임베드 소스 33MB + diff2html 테이블 34MB(코드 행 211,583개) + 기타 8MB**. 브라우저가 이 DOM을 파싱·레이아웃하는 동안 메인 스레드가 점유되어, keydown 리스너가 등록돼 있어도 이벤트가 처리되지 않는다. 시작 스크립트 패스를 defer해도 80MB DOM의 파싱·레이아웃 자체는 줄지 않으므로 해결되지 않는다(검증: jsdom이 이 HTML 파싱 중 4GB heap OOM).

monacori 명제(키보드 우선 리뷰 → 에이전트 프롬프트)에 비춰, 큰 PR을 리뷰조차 못 하면 명제가 깨진다. 이 변경은 필터 "(1) 리뷰가 더 빠른가"를 직접 충족한다.

## What Changes

- **size-conditional 지연 렌더/로드.** 임계 이하(작은 repo·테스트)는 현행 즉시 렌더 그대로 유지. 임계 초과 시 지연 모드로 전환한다.
- **지연 diff**: 파일을 가벼운 '접힌 헤더'로만 라이브 DOM에 렌더. 각 파일의 diff DOM은 펼침/스크롤 진입 시에만 생성하고, 필요하면 멀어질 때 해제해 라이브 노드 수를 제한.
- **지연 소스 + HTML 축소**: 33MB `source-files-data` 일괄 임베드 제거. 파일 소스는 필요 시점(소스 뷰 열기·인덱스 빌드)에 on-demand 로드 — Electron은 IPC, browser-serve는 HTTP 엔드포인트.
- **go-to-def 인덱스 재배치**: 소스가 더 이상 임베드되지 않으므로, 지연 모드에서 인덱스는 소스를 가진 쪽(Electron main 프로세스 / serve 서버)에서 빌드해 렌더러로 전달(현행 렌더러 Web Worker는 비지연 모드의 폴백으로 유지).
- 결과: 초기 HTML이 80MB → 수 MB로 줄어 **repo 크기와 무관하게 즉시 열리고 처음부터 모든 단축키가 동작**.

## Impact

- 영향 코드: `buildDiffReview`/`renderDiffHtml`(생성 분할), `app-main.ts`(IPC 핸들러), `serveDiffWatch`(HTTP 엔드포인트), `preload.cts`(브리지), diffScript(지연 머티리얼라이즈·fetch·인덱스 수신).
- 무회귀 보장 대상: 캐럿 네비게이션, 코멘트(질문/수정요청)·머지뷰, go-to-def(`Cmd/Ctrl+B`)는 지연 모드에서도 정상 동작.
- 작은 repo·jsdom 회귀 스위트: 동작 불변(size-conditional, 임계 이하).
- 신규 capability: `lazy-review-rendering`.
