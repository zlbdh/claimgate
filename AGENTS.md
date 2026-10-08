# ClaimGate Engineering Rules

## File length guidelines

- Ideally, each file stays under 300 lines and has a single responsibility.
- Files with 301–500 lines must be evaluated for splitting by responsibility.
- Files exceeding 500 lines require sufficient justification in the review record.
- Files exceeding 1,000 lines are prohibited and must be split.

## Module boundaries

- Each module owns one clear domain or infrastructure responsibility.
- Modules collaborate through explicit public interfaces; callers must not depend on another module's internal implementation.
- Keep dependencies unidirectional and prohibit cycles. Put shared types behind explicit shared boundaries.
- Comments explain nonobvious reasons and constraints rather than restating the code.
