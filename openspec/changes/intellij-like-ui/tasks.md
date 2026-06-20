## 1. 옵션 상태 · 단축키 · 영속화 골격

- [ ] 1.1 리뷰 옵션 상태 객체(공백 무시 / 접기 / 단어 강조) + `location.pathname` 키 localStorage 로드·저장
- [ ] 1.2 기존 상태 표시줄에 현재 옵션 인디케이터 표시(툴바 없음); 토글 시 짧은 피드백
- [ ] 1.3 옵션 토글용 단축키 핸들러 골격(기존 키와 충돌 없게) + document keydown 라우팅 연결, 입력 포커스 시 억제

## 2. 미변경 영역 접기 🔑 (키스톤 — 먼저 착수, perf 긍정)

- [ ] 2.1 렌더된 diff에서 임계값보다 긴 미변경 행 구간을 감지해 접고, 펼침 가능한 "… N unchanged lines …" 행 삽입
- [ ] 2.2 변경된 줄 + 주변 컨텍스트는 항상 보이게 유지
- [ ] 2.3 클릭 시 펼침; 이동(`F7`/`[`/`]`)이 접힌 영역 안의 줄을 가리키면 자동 펼침
- [ ] 2.4 접기 토글 단축키를 localStorage 옵션에 연결

## 3. 공백 무시 (재diff) 💪

- [ ] 3.1 `buildDiffReview`에 `ignoreWhitespace` 추가 → `git diff`에 `--ignore-all-space` 전달
- [ ] 3.2 Electron: 새 옵션으로 재생성하고 `reloadIgnoringCache()`하는 IPC 채널(예: `monacori:set-options`) 추가(`app-main.ts`의 watch/refresh 재사용) + preload 브리지
- [ ] 3.3 공백 무시 단축키를 IPC 호출에 연결
- [ ] 3.4 비-Electron 폴백으로 `monacori diff`(정적) 경로에 `--ignore-whitespace` 플래그 추가

## 4. 차이 단위 이동 & 카운터

- [ ] 4.1 상태 표시줄에 "현재 / 전체" 차이 카운터 노출 — `setActive` / `next`에 연결
- [ ] 4.2 현재 차이 강조 보장(`diff-active-row` 재사용)하고 `F7` / `Shift+F7` / `[` / `]`에서 카운터 갱신

## 5. 단어 단위 강조 토글

- [ ] 5.1 diff 컨테이너에 줄 안 `<ins>`/`<del>`/`d2h-change` 강조를 토글하는 CSS 클래스 추가
- [ ] 5.2 단어 강조 단축키 연결 + 영속화

## 6. 검증

- [ ] 6.1 `npm run build` 후 임베드 `<script>` 추출 → `node --check`(String.raw 백틱 함정 주의)
- [ ] 6.2 jsdom 하네스 확장: 옵션 단축키 토글 · 상태 인디케이터 · localStorage 영속; 접기가 긴 미변경 구간을 접고 요청 시 펼침; 단어 강조 토글; 차이 카운터가 이동에 맞춰 갱신
- [ ] 6.3 공백 무시 end-to-end 검증(재생성 시 공백만 바뀐 변경이 사라짐) — CLI 플래그 경로는 헤드리스, IPC 경로는 `mo`에서
- [ ] 6.4 `mo` 시각 스모크: 단축키 동작 · 상태 표시 · 접기, 기존 이동/선택/코멘트 무회귀

<!-- 드롭(2026-06-20): "뷰어 모드 토글(side-by-side ↔ unified)" — focus-on-changes 재스코핑에서 제외. 필요 시 별도 change. -->
