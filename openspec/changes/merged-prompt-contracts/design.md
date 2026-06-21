## Context

`buildMergedText(kind)`(`src/viewer.client.js`)는 `reviewComments`를 종류별로 필터해 `# Questions`/`# Change requests` 헤더 + 항목(`### path:line` → `> 캡처코드` → 코멘트 텍스트)으로 직렬화한다. `Cmd+Shift+?`/`>`(또는 Review 메뉴 IPC `onMergedView`)가 `openMergedView`로 편집 가능한 textarea 모달에 띄우고 Copy all을 제공한다. 뷰어는 최근 `String.raw` 블롭에서 실제 `.js`로 추출되어 백틱/템플릿 자유.

## Goals / Non-Goals

**Goals**: 합본 프롬프트가 종류별로 올바른 에이전트 계약을 담아 *행동 가능*해진다. 최소 변경(텍스트만).

**Non-Goals**: export 파이프라인/에이전트 직접 호출(폐기됨), 멀티라인 캡처 펜스화(B1 — 별도 change), 답변 라운드트립 ingest, 언어 설정 UI.

## Decisions

1. **2단계 모델 → 종류별 계약.** 질문=이해(답하라, 코드 변경 금지), 수정요청=행동(고쳐라). `buildMergedText`가 `kind`에 따라 다른 머리말을 prepend.
2. **머리말은 영어**(기존 `# Questions` 헤더와 일관, 코딩 에이전트 친화). 편집 가능 textarea라 사용자가 현지화/삭제 가능 — 설정 UI 불필요.
3. **opt-out by deletion.** 토글/설정 없이 기본 on. 무게 최소(베팅 #1 "Copy all로 충분"과 무충돌 — 파이프라인이 아니라 좋은 기본 텍스트).
4. **위치**: 머리말 → 빈 줄 → 기존 `# Questions/# Change requests (N)` 헤더 → 항목. 기존 직렬화 포맷 보존.

## Risks / Trade-offs

- 머리말이 일부 사용자에겐 군더더기 → 편집 가능 textarea로 완화(지우면 됨).
- 영어 고정 → 한국어 코멘트와 섞일 수 있으나 에이전트는 양쪽 처리. 필요 시 후속.

## Migration Plan

추가형. 기존 합본 뷰·Copy all 동작 유지, 텍스트 앞부분만 추가. 데이터/포맷 마이그레이션 없음.

## Open Questions

- 멀티라인 캡처 펜스화(B1)는 이번 범위 밖(사용자가 B2 선택) — 별도 change 후보.
- 답변→수정요청 라운드트립은 인간 매개로 충분(테제 부합) — 불편 관측 시 재탐색.
