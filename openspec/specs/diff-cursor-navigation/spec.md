# diff-cursor-navigation Specification

## Purpose
TBD - created by archiving change side-diff-cursor-nav. Update Purpose after archive.
## Requirements
### Requirement: side를 구분하는 diff 캐럿
side-by-side diff 뷰는 `(file, side, line, column)`로 식별되는 캐럿 위치를 유지해야 한다(SHALL). `side`는 `old`(왼쪽 패널) 또는 `new`(오른쪽 패널)이다. 캐럿은 활성 패널에 보이는 표시로 렌더되어야 한다(SHALL).

#### Scenario: 클릭으로 캐럿을 놓는다
- **WHEN** 사용자가 old 또는 new 패널의 코드 줄을 클릭할 때
- **THEN** 캐럿이 그 패널의 `(side, line, column)`으로 이동하고 그 위치에 보이는 캐럿 표시가 나타난다

#### Scenario: 파일이 보이는 동안 캐럿이 유지된다
- **WHEN** 캐럿이 있고 사용자가 파일을 바꾸지 않은 채 스크롤할 때
- **THEN** 캐럿 위치가 보존되고 동일한 `(side, line)`에 계속 고정된다

### Requirement: 패널 내 이동
diff 뷰가 포커스인 동안 화살표 키는 캐럿을 이동해야 한다(SHALL): `Up`/`Down`은 현재 패널 안에서 한 줄씩, `Left`/`Right`는 한 칸씩.

#### Scenario: Down이 다음 줄로 이동
- **WHEN** 캐럿이 N번째 줄에 있고 사용자가 `Down`을 누를 때
- **THEN** 캐럿이 같은 패널의 N+1번째 줄로 이동한다(마지막 줄에서 클램프)

#### Scenario: Left가 줄 중간에서 칸 단위로 이동
- **WHEN** 캐럿 column이 0보다 크고 사용자가 `Left`를 누를 때
- **THEN** 캐럿 column이 1 줄고 같은 패널에 머문다

### Requirement: 패널 간 캐럿 이동
패널 간 이동은 명시적으로 `Cmd/Ctrl + Left/Right`로만 일어나야 한다(SHALL). 일반 화살표는 패널을 건너서는 안 된다(MUST NOT) — 같은 패널 안에서만 이동한다. `Cmd/Ctrl + Left/Right`는 먼저 줄 시작/끝으로 이동하고, 이미 줄 시작/끝이면 한 번 더 눌렀을 때 인접 패널(왼쪽=old, 오른쪽=new)의 정렬된 행으로 건너가야 한다(SHALL).

#### Scenario: 일반 화살표는 패널을 건너지 않는다
- **WHEN** 캐럿이 한 패널 줄의 끝(또는 시작)에 있고 사용자가 일반 `Right`(또는 `Left`)를 누를 때
- **THEN** 캐럿은 반대 패널로 건너가지 않고 같은 패널의 다음(또는 이전) 코드 줄로 이동한다

#### Scenario: Cmd+Right로 old → new 건넘 (줄 끝에서 한 번 더)
- **WHEN** 캐럿이 old(왼쪽) 패널 줄의 끝에 있고 사용자가 `Cmd/Ctrl + Right`를 누를 때
- **THEN** 캐럿이 new(오른쪽) 패널의 정렬된 행으로 건너간다

#### Scenario: Cmd+Left로 new → old 건넘 (줄 시작에서 한 번 더)
- **WHEN** 캐럿이 new(오른쪽) 패널 줄의 시작(column 0)에 있고 사용자가 `Cmd/Ctrl + Left`를 누를 때
- **THEN** 캐럿이 old(왼쪽) 패널의 정렬된 행으로 건너간다

#### Scenario: 빈 placeholder에는 캐럿이 가지 않는다
- **WHEN** 건너가려는 반대편 정렬 행이 빈 placeholder(그쪽엔 대응 줄이 없는 추가/삭제 줄)일 때
- **THEN** 캐럿은 placeholder로 건너가지 않고, 텍스트·줄번호 있는 실제 코드 줄에만 머문다

### Requirement: 캐럿이 줄 단위 동작의 앵커가 됨
diff에서 줄 단위 동작은 선택이 없을 때 캐럿 위치를 사용해야 한다(SHALL): 코멘트 생성(`?` / `>`)과 "캐럿 위치의 소스 열기"가 대상 파일과 줄을 캐럿의 `(side, line)`에서 해석해야 한다(MUST).

#### Scenario: 코멘트가 캐럿 줄에 앵커된다
- **WHEN** diff 캐럿이 `(side, line)`에 있고 활성 텍스트 선택이 없는 상태에서 사용자가 `?`를 누를 때
- **THEN** 그 파일과 줄에 앵커된 질문 코멘트 컴포저가 열린다

#### Scenario: 캐럿 줄의 소스 열기
- **WHEN** diff 캐럿이 설정된 상태에서 사용자가 "캐럿 위치의 소스 열기"를 실행할 때
- **THEN** 같은 줄에 캐럿을 둔 채 소스 뷰가 열린다

### Requirement: 기존 diff 상호작용과의 공존
캐럿 추가가 기존 hunk 이동이나 마우스 선택을 바꿔서는 안 되며(MUST NOT), 텍스트 입력에 포커스가 있을 때는 캐럿 키가 발동해서는 안 된다(MUST NOT).

#### Scenario: F7 hunk 이동 시 캐럿이 따라간다
- **WHEN** 사용자가 `F7`(또는 `Shift+F7` / `[` / `]`)로 hunk를 이동할 때
- **THEN** 기존 hunk 이동(스크롤·하이라이트)이 동작하고, 캐럿도 그 hunk의 변경 줄(가능하면 new 쪽)로 이동한다

#### Scenario: 드래그 선택이 여전히 코드를 캡처한다
- **WHEN** 사용자가 diff에서 텍스트를 드래그 선택하고 코멘트를 만들 때
- **THEN** 선택이 이전처럼 동작하고 선택한 코드가 코멘트와 함께 캡처된다

#### Scenario: 입력 안에서는 캐럿 키가 억제된다
- **WHEN** `input`, `textarea`, `select`(예: 검색창이나 코멘트 컴포저)에 포커스가 있을 때
- **THEN** 화살표 키가 그 필드에서 정상 동작하고 diff 캐럿을 움직이지 않는다

