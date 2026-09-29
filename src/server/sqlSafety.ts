const forbidden=/\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|analyze|transaction|begin|commit|rollback)\b/i;
export function assertReadOnlySql(sql:string){const q=sql.trim(); if(!/^(select|with)\b/i.test(q)||forbidden.test(q)||q.includes(';')) throw new Error('Only one read-only SELECT/CTE query is allowed'); return q;}
