// Read and validate every budget before changing any counter. A rejected request
// must not spend another recipient's or the whole service's capacity.
export const ATOMIC_BUDGET_SCRIPT = `
local counts = {}
local ttls = {}
local blocked = 0
for i = 1, #KEYS do
  local raw = redis.call('GET', KEYS[i])
  local count = tonumber(raw or '0')
  -- TTL은 반올림해 최대 0.5초 짧다. 재시도 안내가 실제보다 짧지 않게 PTTL을 올림한다.
  local ttl = redis.call('PTTL', KEYS[i])
  if ttl > 0 then ttl = math.ceil(ttl / 1000) end
  if not count or count < 0 or count > 1000000000 or count ~= math.floor(count)
    or (raw and (tostring(count) ~= raw or ttl < 0)) then
    return redis.error_reply('Invalid budget counter')
  end
  counts[i] = count
  ttls[i] = ttl
  if count >= tonumber(ARGV[i * 2]) then
    if blocked == 0 or ttl > ttls[blocked] then blocked = i end
  end
end
if blocked > 0 then
  return { blocked, counts[blocked], math.max(0, ttls[blocked]), 0 }
end
for i = 1, #KEYS do
  counts[i] = redis.call('INCR', KEYS[i])
  if ttls[i] < 0 then
    ttls[i] = tonumber(ARGV[i * 2 - 1])
    redis.call('EXPIRE', KEYS[i], ttls[i])
  end
end
return { 1, counts[1], math.max(0, ttls[1]), 1 }
`;
