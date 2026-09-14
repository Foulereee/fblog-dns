# fblog-dns local smoke test (run with: npx wrangler dev --port 8787)
$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:8787'

# 1) front page
try {
  $resp = Invoke-WebRequest -Uri "$base/" -UseBasicParsing
  Write-Host "1) GET /            => $($resp.StatusCode)  (HTML $($resp.Content.Length) bytes)"
} catch {
  Write-Host "1) GET /            => FAIL $($_.Exception.Message)"
}

# 2) admin create user
try {
  $headers = @{ Authorization = 'Bearer test-admin-password-123' }
  $body = @{ username = 'alice'; password = 'secret12345' } | ConvertTo-Json
  $r = Invoke-RestMethod -Uri "$base/api/admin/users" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
  Write-Host "2) admin create user => OK $($r | ConvertTo-Json -Compress)"
} catch {
  Write-Host "2) admin create user => $($_.Exception.Response.StatusCode.value__) $($_.ErrorDetails.Message)"
}

# 2b) duplicate user should be 409
try {
  $headers = @{ Authorization = 'Bearer test-admin-password-123' }
  $body = @{ username = 'alice'; password = 'secret12345' } | ConvertTo-Json
  $null = Invoke-RestMethod -Uri "$base/api/admin/users" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
  Write-Host "2b) duplicate user  => UNEXPECTED OK"
} catch {
  Write-Host "2b) duplicate user  => $($_.Exception.Response.StatusCode.value__) $($_.ErrorDetails.Message) (expect 409)"
}

# 3) login
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
try {
  $body = @{ username = 'alice'; password = 'secret12345' } | ConvertTo-Json
  $r = Invoke-RestMethod -Uri "$base/api/login" -Method Post -WebSession $session -ContentType 'application/json' -Body $body
  Write-Host "3) login            => OK $($r | ConvertTo-Json -Compress)"
} catch {
  Write-Host "3) login            => $($_.Exception.Response.StatusCode.value__) $($_.ErrorDetails.Message)"
}

# 4) current user
try {
  $r = Invoke-RestMethod -Uri "$base/api/me" -Method Get -WebSession $session
  Write-Host "4) me               => OK $($r | ConvertTo-Json -Compress)"
} catch {
  Write-Host "4) me               => FAIL $($_.Exception.Message)"
}

# 5) invalid A value should be 400
try {
  $body = @{ subdomain = 'myapp'; type = 'A'; value = '999.1.1.1' } | ConvertTo-Json
  $null = Invoke-RestMethod -Uri "$base/api/records" -Method Post -WebSession $session -ContentType 'application/json' -Body $body
  Write-Host "5) bad A value      => UNEXPECTED OK"
} catch {
  Write-Host "5) bad A value      => $($_.Exception.Response.StatusCode.value__) $($_.ErrorDetails.Message) (expect 400)"
}

# 6) reserved subdomain should be 400
try {
  $body = @{ subdomain = 'www'; type = 'A'; value = '1.2.3.4' } | ConvertTo-Json
  $null = Invoke-RestMethod -Uri "$base/api/records" -Method Post -WebSession $session -ContentType 'application/json' -Body $body
  Write-Host "6) reserved sub     => UNEXPECTED OK"
} catch {
  Write-Host "6) reserved sub     => $($_.Exception.Response.StatusCode.value__) $($_.ErrorDetails.Message) (expect 400)"
}

# 7) valid record (dummy token locally: expect Cloudflare API error = integration wired)
try {
  $body = @{ subdomain = 'myapp'; type = 'A'; value = '1.2.3.4' } | ConvertTo-Json
  $r = Invoke-RestMethod -Uri "$base/api/records" -Method Post -WebSession $session -ContentType 'application/json' -Body $body
  Write-Host "7) create record    => OK $($r | ConvertTo-Json -Compress)"
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  $msg = $_.ErrorDetails.Message
  Write-Host "7) create record    => $code $msg (dummy token: expect Cloudflare API reject)"
}

# 8) delete without auth should be 401
try {
  $null = Invoke-RestMethod -Uri "$base/api/records/1" -Method Delete
  Write-Host "8) delete no-auth   => UNEXPECTED OK"
} catch {
  Write-Host "8) delete no-auth   => $($_.Exception.Response.StatusCode.value__) $($_.ErrorDetails.Message) (expect 401)"
}

# 9) list without auth should be 401
try {
  $null = Invoke-RestMethod -Uri "$base/api/records" -Method Get
  Write-Host "9) list no-auth     => UNEXPECTED OK"
} catch {
  Write-Host "9) list no-auth     => $($_.Exception.Response.StatusCode.value__) $($_.ErrorDetails.Message) (expect 401)"
}
