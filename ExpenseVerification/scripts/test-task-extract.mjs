/**
 * Tests for task-extract.js, using real text from the hbegroupprojects
 * portal (Travel Advance Request Form tables flattened to plain text, plus
 * free-text approval comments).
 *
 * Run: node ExpenseVerification/scripts/test-task-extract.mjs
 */
import { extractTaskFields } from '../functions/api/_lib/task-extract.js';

const CASES = [
  {
    name: 'CA1-T2293 — Mohit Kumar (flattened Travel Advance table)',
    text: 'Travel Advance Request Form Three   D Integrated Solutions Ltd Employee Name Mohit   Kumar Date 6-Jul-26 Employee Code HO-0240 Designation Engineer Grade Project Code FTI Location Delhi Cost Center Travel to ( Place to visited ) Jaipur   ,Madurai, jaisalmer Purpose of Travel ITC   Work, CPE-PM. Start Date 1-Jul-26 End of Travel 25-Jul-26 Advance Amount ( As per break up given below ) AIR/RAIL/BUS/Taxi Fare Up/ Down Conveyance 1000*25= 25000 Boarding Fooding 700*25=  17500 Lodging 1900*24=45600 Misc Total 88100 Amount in words EIGHTY   EIGHT THOUSAND ONE HUNDERD  ONLY',
    expect: { employeeId: 'HO-0240', employeeName: 'Mohit Kumar', claimAmount: '88100' },
  },
  {
    name: 'SO7-T1 — Ramniwash (flattened table, comma amount)',
    text: 'Travel Advance Request Form Three   D Integrated Solutions Ltd Employee Name Ramniwash Date 4-Sep-25 Employee Code RHQ-047 Designation CNS   Engineer Grade CNS   Engineer Project Code DVR Location Ajmer Cost Center DVR Travel From Ajmer Total 76,600 Amount in words Seventy   Six Thousand Six Hundred Only',
    expect: { employeeId: 'RHQ-047', employeeName: 'Ramniwash', claimAmount: '76600' },
  },
  {
    name: 'CA1-T2348 — Rajkumar (stray spaces around the dash; the case that broke Deluge)',
    text: 'Travel Advance Request Form Employee Name Rajkumar   Hariyana Date 5-Aug-26 Employee Code ETD -   012 Designation Technician Project Code ETD Location Jamnagar Advance Amount ( As per break up given below ) Conveyance 500*10=5000 Total 45000 Amount in words Forty Five Thousand Only',
    expect: { employeeId: 'ETD-012', employeeName: 'Rajkumar Hariyana', claimAmount: '45000' },
  },
  {
    name: 'RHQ-047 — free-text approval comment',
    text: 'Approve plz Tour Advance Emp ID- RHQ-047 Emp Name- Ramniwash Amount -15000',
    expect: { employeeId: 'RHQ-047', employeeName: 'Ramniwash', claimAmount: '15000' },
  },
  {
    name: 'HO-402 — space instead of dash in the code',
    text: 'Tour advance 8000 for IGURA Emp Id=HO 402 Emp Name- Ajay Kumar Designation: Manager IT',
    expect: { employeeId: 'HO-402', employeeName: 'Ajay Kumar', claimAmount: '' },
  },
  {
    name: 'header-only text must not yield a bogus amount',
    text: 'Advance Amount ( As per break up given below ) Amount in words EIGHTY EIGHT THOUSAND ONLY',
    expect: { employeeId: '', employeeName: '', claimAmount: '' },
  },
  {
    name: 'empty input',
    text: '',
    expect: { employeeId: '', employeeName: '', claimAmount: '' },
  },
];

let failed = 0;
for (const c of CASES) {
  const got = extractTaskFields(c.text);
  const bad = Object.keys(c.expect).filter(k => got[k] !== c.expect[k]);
  if (bad.length) {
    failed++;
    console.log(`FAIL  ${c.name}`);
    for (const k of bad) console.log(`        ${k}: expected ${JSON.stringify(c.expect[k])}, got ${JSON.stringify(got[k])}`);
  } else {
    console.log(`ok    ${c.name}`);
  }
}

console.log(failed ? `\n${failed} of ${CASES.length} failed` : `\nall ${CASES.length} passed`);
process.exit(failed ? 1 : 0);
