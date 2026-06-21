# merged-prompt Specification

## Purpose
TBD - created by archiving change merged-prompt-contracts. Update Purpose after archive.
## Requirements
### Requirement: 종류별 에이전트 계약 머리말
합본 프롬프트는 종류에 맞는 에이전트 계약 머리말을 포함해야 한다(SHALL). 질문 합본은 "코드를 변경하지 말고 답하라"는 의도를, 수정요청 합본은 "각 항목의 코드를 요청대로 수정하라"는 의도를 담아야 한다(SHALL). 머리말은 기존 `# Questions`/`# Change requests` 헤더와 항목 직렬화 앞에 와야 한다(SHALL).

#### Scenario: 질문 합본의 계약
- **WHEN** 사용자가 질문 합본 뷰(`Cmd/Ctrl+Shift+/`)를 열 때
- **THEN** 프롬프트가 "질문에 답하되 코드는 고치지 말라"는 머리말로 시작한다

#### Scenario: 수정요청 합본의 계약
- **WHEN** 사용자가 수정요청 합본 뷰(`Cmd/Ctrl+Shift+.`)를 열 때
- **THEN** 프롬프트가 "각 항목의 코드를 요청대로 수정하라"는 머리말로 시작한다

#### Scenario: 항목 직렬화 보존
- **WHEN** 합본 프롬프트가 생성될 때
- **THEN** 머리말 뒤에 기존 형식(`### path:line` → 캡처 코드 → 코멘트 텍스트)이 그대로 유지된다

### Requirement: 편집 가능 + opt-out
합본 뷰는 편집 가능해야 하며(SHALL), 사용자가 복사 전에 머리말을 포함한 어떤 부분도 제거할 수 있어야 한다(SHALL). 머리말 제거를 위한 토글/설정을 추가해서는 안 된다(MUST NOT).

#### Scenario: 머리말 제거
- **WHEN** 사용자가 합본 뷰 textarea에서 머리말을 지우고 Copy all 할 때
- **THEN** 머리말 없이 복사된다
