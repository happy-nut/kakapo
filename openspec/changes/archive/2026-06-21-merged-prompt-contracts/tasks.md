## 1. 구현

- [x] 1.1 `src/viewer.client.js`의 `buildMergedText(kind)`에 종류별 계약 머리말 prepend — 질문(`q`)=답·코드변경금지, 수정요청(`c`)=요청대로 수정. 머리말 → 빈 줄 → 기존 `# Questions`/`# Change requests (N)` 헤더 → 항목 순. 기존 직렬화 보존

## 2. 검증

- [x] 2.1 `npm run build`(0). 추출 뷰어라 String.raw 백틱 함정 없음
- [x] 2.2 jsdom `merged-ipc`(7 PASS): 질문/수정요청 합본 textarea가 각각 올바른 계약 머리말로 시작(헤더 앞) + 종류별 상이 + 기존 항목 직렬화·Copy all 유지. 코멘트 회귀(COMMENT 23·REVIEW-UX 15·BOX-NAV 11) 무영향
