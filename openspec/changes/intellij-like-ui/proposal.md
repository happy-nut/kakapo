## Why

monacori의 리뷰를 **변경된 코드에 집중**시키면 빠르고 가벼워진다(제1원칙). 원래 "IntelliJ diff 뷰어처럼"으로 출발했지만, 테제(`openspec/project.md`) 렌즈로 보면 진짜 목표는 *IntelliJ 닮기*가 아니라 **변경에 집중 + 리뷰 속도**다. 지금 monacori는 모든 파일의 전체 컨텍스트를 그대로 렌더해 미변경 줄이 화면·렌더비용을 잡아먹고, 공백만 바뀐 노이즈가 리뷰를 흐린다.

## What Changes

테제 필터("리뷰를 더 빠르게 하나?")로 우선순위를 다시 잡았다:

- **🔑 미변경 영역 접기 (키스톤)**: 긴 미변경 구간을 펼침 가능한 "… N unchanged lines …"로 접는다 — 변경에 집중 + 렌더 행 수 감소(perf).
- **💪 공백 무시**: 공백을 무시하고 diff를 다시 계산해, 포맷만 바뀐 줄을 리뷰에서 뺀다(노이즈 제거).
- **🙂 차이 단위 이동 카운터**: 기존 `F7`/`[`/`]` 위에 "현재 / 전체" 카운터 + 현재 차이 강조(방향감).
- **🙂 단어 단위 강조 토글**: 줄 안(intra-line) 변경 강조 켜고 끄기(명료성).
- 각 옵션은 **키보드 단축키로 토글**(툴바 없음), 상태 표시줄에 간결히 표시, repo별 영속화(localStorage).

**드롭/보류**: side-by-side ↔ unified **뷰어 모드 토글**은 리뷰 속도·프롬프트 품질과 무관한 취향이라 이번 스코프에서 뺀다(필요 시 후속).

## Capabilities

### New Capabilities
- `intellij-like-diff-ui`: 변경에 집중하는 diff 리뷰 동작 — 미변경 접기, 공백 무시, 차이 카운터, 단어 강조. 키보드로 토글하고 선택값을 영속화한다(툴바 없음). *(원래 "IntelliJ식"으로 명명되었으나 실제 목표는 focus-on-changes.)*

### Modified Capabilities
<!-- 없음 -->

## Impact

- `src/cli.ts` — 임베드 뷰어(`diffScript()` + `diffCss()`): 미변경 접기 DOM 폴딩, 옵션 토글 단축키, 단어 강조 CSS 토글, 차이 카운터, 상태 표시줄 인디케이터 + localStorage 영속.
- 공백 무시는 diff 재생성(`git diff -w`)이 필요 → `buildDiffReview` + Electron 재생성·리로드 IPC(`app-main.ts` watch/refresh 재사용) + 정적 `diff` CLI 플래그.
- 새 의존성 없음. 읽기 전용 리뷰 동작은 그대로.
