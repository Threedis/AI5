# Employee Expense Verification System

Enterprise-grade static HTML application for verifying employee bank details before salary and reimbursement payments.

## Deployment

Host on GitHub Pages. No backend required.

## Default Credentials

| Username | Password   | Role          |
|----------|------------|---------------|
| admin    | Admin@1234 | Administrator |

> Change the default password immediately after first login.

## Phase Status

| Phase | Description                        | Status      |
|-------|------------------------------------|-------------|
| 1     | Framework, Login, Dashboard, Theme | ✅ Complete  |
| 2     | Auth, Role Management, IndexedDB   | ✅ Complete  |
| 3     | HR Upload, Validation, Versioning  | 🔜 Next      |
| 4     | Accounts Upload, Parser            | 🔜 Pending   |
| 5     | PDF Approval, Verification Engine  | 🔜 Pending   |
| 6     | Payment Files, Reports, Charts     | 🔜 Pending   |
| 7     | GitHub Backup, Rollback            | 🔜 Pending   |
| 8     | Testing, Optimization              | 🔜 Pending   |

## Tech Stack

- HTML5 + CSS3 + ES6+
- Bootstrap 5 (layout utilities)
- CryptoJS AES-256 (encryption)
- IndexedDB (local storage)
- Chart.js (charts)
- SheetJS / ExcelJS (Excel)
- PDF.js (PDF extraction)
- Font Awesome 6 (icons)
- GitHub REST API (encrypted backup)
