## 2025-02-12 - [Array State Updates]
**Learning:** In React, applying array state updates by chaining an O(N) `.find()` immediately into an O(N) `.map()` causes unnecessary multiple traversals over the same data.
**Action:** Consolidate array transformations into a single `.map()` loop by capturing or computing necessary diffs inline for the matched item, dropping redundant `.find()` calls to save cpu cycles during drags or continuous state updates.
