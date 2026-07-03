                        User Browser
                    (Static HTML + JavaScript)
                               │
                               │
                Drag & Drop Upload Interface
                               │
───────────────────────────────┼───────────────────────────────
                               │
                 Client-side Processing Engine
                               │
       ┌──────────────┬───────────────┬───────────────┐
       │              │               │
       ▼              ▼               ▼
 Excel Parser    PDF Parser      Validation Engine
       │              │               │
       └──────────────┴───────────────┘
                      │
                      ▼
              Matching Engine
                      │
      ┌───────────────┼─────────────────┐
      ▼               ▼                 ▼
 HR Master      Bank Advice       Approval Checker
 Database          Data
      │               │
      └───────────────┴───────────────┐
                                      ▼
                           Result Generator
                                      │
                     ┌────────────────┼────────────────┐
                     ▼                ▼                ▼
               HDFC File      NES File        Discrepancy Report
