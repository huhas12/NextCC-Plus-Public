<?php
declare(strict_types=1);
// SPDX-License-Identifier: AGPL-3.0-or-later
namespace OCA\VideoSubtitles\Service;

use OCP\IConfig;
use OCP\Http\Client\IClientService;
use OCP\Http\Client\IResponse;
use OCP\Security\ICrypto;

final class OpenSubtitlesService {
    private const HOSTS = ['api.opensubtitles.com', 'vip-api.opensubtitles.com'];
    private const AGENT = 'NextcloudVideoSubtitles v0.4.1';
    private const KEY = 'opensubtitles_connection';
    private const APPLICATION_KEY = 'opensubtitles_application_key';
    private const MAX_SUBTITLE = 2097152;

    public function __construct(private IConfig $config, private ICrypto $crypto, private IClientService $clients) {
    }

    private function stored(string $uid): array {
        $value = $this->config->getUserValue($uid, 'videosubtitles', self::KEY, '');
        if ($value === '') return [];
        try { $data = json_decode($this->crypto->decrypt($value), true, 32, JSON_THROW_ON_ERROR); }
        catch (\Throwable) { return []; }
        return is_array($data) ? $data : [];
    }

    private function applicationKey(): string {
        $encrypted = $this->config->getAppValue('videosubtitles', self::APPLICATION_KEY, '');
        if ($encrypted !== '') {
            try { return $this->crypto->decrypt($encrypted); }
            catch (\Throwable) { return ''; }
        }
        // Keep compatibility with the administrator's original occ configuration.
        return $this->config->getAppValue('videosubtitles', 'opensubtitles_api_key', '');
    }

    private function apiKey(array $connection): string {
        if (($connection['keySource'] ?? '') === 'application') return $this->applicationKey();
        $personal = $connection['apiKey'] ?? '';
        return is_string($personal) && $personal !== '' ? $personal : $this->applicationKey();
    }

    public function configureApplicationKey(string $apiKey, bool $clear = false): void {
        if ($clear) {
            $this->config->deleteAppValue('videosubtitles', self::APPLICATION_KEY);
            $this->config->deleteAppValue('videosubtitles', 'opensubtitles_api_key');
            return;
        }
        $apiKey = trim($apiKey);
        if ($apiKey === '' || strlen($apiKey) > 512 || preg_match('/[^\x21-\x7e]/', $apiKey)) throw new ApiException('invalid_api_key');
        $this->config->setAppValue('videosubtitles', self::APPLICATION_KEY, $this->crypto->encrypt($apiKey));
        $this->config->deleteAppValue('videosubtitles', 'opensubtitles_api_key');
    }

    public function status(string $uid): array {
        $value = $this->stored($uid);
        $configured = $this->apiKey($value) !== '';
        $sameApplication = ($value['keySource'] ?? '') !== 'application'
            || hash_equals((string)($value['applicationKeyId'] ?? ''), hash('sha256', $this->applicationKey()));
        return ['connected' => $configured && $sameApplication && !empty($value['token']) && ($value['expiresAt'] ?? 0) > time(),
            'apiKeyConfigured' => $configured, 'applicationKeyConfigured' => $this->applicationKey() !== '',
            'username' => (string)($value['username'] ?? ''), 'expiresAt' => (int)($value['expiresAt'] ?? 0)];
    }

    public static function apiHost(string $host): string {
        if (!in_array($host, self::HOSTS, true)) throw new ApiException('invalid_api_host', 502);
        return $host;
    }

    /** Redirect targets and download links must stay on HTTPS OpenSubtitles hosts. */
    public static function downloadUrl(string $url): string {
        $parts = parse_url($url);
        $host = strtolower((string)($parts['host'] ?? ''));
        if (($parts['scheme'] ?? '') !== 'https' || ($parts['port'] ?? 443) !== 443
            || isset($parts['user']) || isset($parts['pass']) || isset($parts['fragment'])
            || ($host !== 'opensubtitles.com' && !str_ends_with($host, '.opensubtitles.com'))
            || strlen($url) > 8192 || preg_match('/[\x00-\x20\x7f]/', $url)) throw new ApiException('invalid_download_url', 502);
        return $url;
    }

    private static function body(IResponse $response, int $limit): string {
        $length = $response->getHeader('Content-Length');
        if (is_numeric($length) && (float)$length > $limit) throw new ApiException('response_too_large', 502);
        $body = $response->getBody();
        if (is_resource($body)) {
            try { $text = stream_get_contents($body, $limit + 1); }
            finally { fclose($body); }
        } else { $text = is_string($body) ? $body : ''; }
        if ($text === false || strlen($text) > $limit) throw new ApiException('response_too_large', 502);
        return $text;
    }

    private function request(string $method, string $host, string $endpoint, string $key, string $token = '', ?array $body = null, array $query = []): array {
        self::apiHost($host);
        if ($key === '' || strlen($key) > 512 || preg_match('/[\r\n]/', $key)) throw new ApiException('api_key_required', 503);
        $headers = ['Api-Key' => $key, 'User-Agent' => self::AGENT, 'Accept' => 'application/json'];
        if ($token !== '') {
            if (strlen($token) > 8192 || preg_match('/[\r\n]/', $token)) throw new ApiException('login_required', 401);
            $headers['Authorization'] = 'Bearer ' . $token;
        }
        ksort($query);
        $url = 'https://' . $host . '/api/v1/' . $endpoint . ($query ? '?' . http_build_query($query, '', '&', PHP_QUERY_RFC3986) : '');
        $options = ['headers' => $headers, 'timeout' => 20, 'connect_timeout' => 8,
            'allow_redirects' => false, 'http_errors' => false, 'stream' => true];
        if ($body !== null) { $options['headers']['Content-Type'] = 'application/json'; $options['body'] = json_encode($body, JSON_THROW_ON_ERROR); }
        try {
            $client = $this->clients->newClient();
            $response = $client->request($method, $url, $options);
            // Sorted parameters normally avoid redirects. Follow only safe GET redirects within the API.
            for ($hop = 0; $hop < 2 && $method === 'GET' && in_array($response->getStatusCode(), [301, 302, 307, 308], true); $hop++) {
                $location = $response->getHeader('Location');
                if (str_starts_with($location, '/api/v1/')) $location = 'https://' . $host . $location;
                $parts = parse_url($location);
                if (($parts['scheme'] ?? '') !== 'https' || isset($parts['user']) || isset($parts['pass']) || isset($parts['fragment'])
                    || ($parts['port'] ?? 443) !== 443 || !str_starts_with($parts['path'] ?? '', '/api/v1/')) throw new ApiException('api_redirect', 502);
                self::apiHost((string)($parts['host'] ?? ''));
                self::body($response, 1048576);
                $response = $client->request('GET', $location, $options);
            }
            $status = $response->getStatusCode();
            $text = self::body($response, 1048576);
        } catch (ApiException $e) { throw $e; }
        catch (\Throwable) { throw new ApiException('opensubtitles_unavailable', 502); }
        if ($status === 401) throw new ApiException('login_required', 401);
        if ($status === 403) throw new ApiException('opensubtitles_forbidden', 403);
        if (in_array($status, [406, 429], true)) throw new ApiException('quota_or_rate_limit', 429);
        if ($status < 200 || $status >= 300) throw new ApiException('opensubtitles_error', 502);
        try { $result = json_decode($text, true, 64, JSON_THROW_ON_ERROR); }
        catch (\Throwable) { throw new ApiException('invalid_api_response', 502); }
        if (!is_array($result)) throw new ApiException('invalid_api_response', 502);
        return $result;
    }

    public function connect(string $uid, string $username, string $password, string $apiKey): array {
        $username = trim($username);
        if ($username === '' || strlen($username) > 200 || $password === '' || strlen($password) > 1024) throw new ApiException('invalid_credentials');
        $previous = $this->stored($uid);
        $personal = trim($apiKey);
        $application = $this->applicationKey();
        $source = $personal !== '' ? 'personal' : ($application !== '' ? 'application' : ($previous['keySource'] ?? 'personal'));
        $key = $personal !== '' ? $personal : ($application !== '' ? $application : $this->apiKey($previous));
        $data = $this->request('POST', self::HOSTS[0], 'login', $key, '', ['username' => $username, 'password' => $password]);
        $token = $data['token'] ?? '';
        if (!is_string($token) || $token === '' || strlen($token) > 8192 || preg_match('/[\r\n]/', $token)) throw new ApiException('invalid_api_response', 502);
        $host = self::apiHost((string)($data['base_url'] ?? self::HOSTS[0]));
        $expires = time() + 86400;
        $parts = explode('.', $token);
        if (count($parts) === 3) {
            $claims = json_decode((string)base64_decode(strtr($parts[1], '-_', '+/')), true);
            if (is_array($claims) && isset($claims['exp']) && is_numeric($claims['exp'])) $expires = min($expires, (int)$claims['exp']);
        }
        if ($expires <= time()) throw new ApiException('login_required', 401);
        // A shared key stays in app configuration; each user stores only their token and key source.
        // An explicit personal key is retained for optional overrides. Never store the password.
        $value = ['keySource' => $source, 'token' => $token, 'base' => $host, 'username' => $username, 'expiresAt' => $expires];
        if ($source === 'personal') $value['apiKey'] = $key;
        else $value['applicationKeyId'] = hash('sha256', $key);
        $this->config->setUserValue($uid, 'videosubtitles', self::KEY, $this->crypto->encrypt(json_encode($value, JSON_THROW_ON_ERROR)));
        return $this->status($uid);
    }

    private function connection(string $uid): array {
        $value = $this->stored($uid);
        if (!$this->status($uid)['connected']) throw new ApiException('login_required', 401);
        self::apiHost((string)($value['base'] ?? ''));
        return $value;
    }

    public function disconnect(string $uid): array {
        $value = $this->stored($uid);
        try {
            if (!empty($value['token'])) $this->request('DELETE', self::apiHost((string)($value['base'] ?? '')), 'logout', $this->apiKey($value), $value['token']);
        } catch (\Throwable) { /* Always remove local credentials, even if logout is unavailable. */ }
        $this->config->deleteUserValue($uid, 'videosubtitles', self::KEY);
        return $this->status($uid);
    }

    public function languages(string $uid): array {
        $value = $this->stored($uid);
        $data = $this->request('GET', self::apiHost((string)($value['base'] ?? self::HOSTS[0])), 'infos/languages', $this->apiKey($value), (string)($value['token'] ?? ''));
        if (!is_array($data['data'] ?? null)) throw new ApiException('invalid_api_response', 502);
        $languages = [];
        foreach (array_slice($data['data'] ?? [], 0, 300) as $entry) {
            if (isset($entry['language_code'], $entry['language_name']) && preg_match('/^[a-z]{2,3}(?:-[a-z]{2,3})?$/D', $entry['language_code'])) {
                $languages[] = ['code' => $entry['language_code'], 'name' => substr((string)$entry['language_name'], 0, 100)];
            }
        }
        return $languages;
    }

    public function search(string $uid, string $query, array $languages, string $hash, int $page, int $year, int $season, int $episode): array {
        $connection = $this->connection($uid);
        $query = trim($query);
        if (strlen($query) > 300 || ($query === '' && $hash === '')) throw new ApiException('invalid_query');
        if ($hash !== '' && !preg_match('/^[0-9a-f]{16}$/D', $hash)) throw new ApiException('invalid_hash');
        $filters = ['page' => max(1, min(100, $page))];
        if ($query !== '') $filters['query'] = mb_strtolower($query);
        if ($hash !== '') $filters['moviehash'] = $hash;
        $clean = PreferenceService::normalize(['subtitleLanguages' => $languages])['subtitleLanguages'];
        if ($clean) $filters['languages'] = implode(',', $clean);
        if ($year >= 1888 && $year <= 2100) $filters['year'] = $year;
        if ($season > 0 && $season <= 200) $filters['season_number'] = $season;
        if ($episode > 0 && $episode <= 2000) $filters['episode_number'] = $episode;
        $data = $this->request('GET', $connection['base'], 'subtitles', $this->apiKey($connection), $connection['token'], null, $filters);
        if (!is_array($data['data'] ?? null)) throw new ApiException('invalid_api_response', 502);
        $results = [];
        foreach (array_slice($data['data'] ?? [], 0, 100) as $subtitle) {
            $attrs = $subtitle['attributes'] ?? [];
            foreach (array_slice($attrs['files'] ?? [], 0, 10) as $file) {
                if (!isset($file['file_id']) || !is_numeric($file['file_id']) || (int)$file['file_id'] <= 0) continue;
                $results[] = ['fileId' => (int)$file['file_id'], 'fileName' => substr((string)($file['file_name'] ?? ''), 0, 300),
                    'language' => substr((string)($attrs['language'] ?? ''), 0, 12), 'release' => substr((string)($attrs['release'] ?? ''), 0, 300),
                    'title' => substr((string)($attrs['feature_details']['title'] ?? ''), 0, 300),
                    'downloads' => max(0, (int)($attrs['download_count'] ?? 0)), 'rating' => (float)($attrs['ratings'] ?? 0),
                    'hashMatch' => (bool)($attrs['moviehash_match'] ?? false), 'hearingImpaired' => (bool)($attrs['hearing_impaired'] ?? false),
                    'aiTranslated' => (bool)($attrs['ai_translated'] ?? false), 'machineTranslated' => (bool)($attrs['machine_translated'] ?? false),
                    'trusted' => (bool)($attrs['from_trusted'] ?? false)];
                if (count($results) >= 100) break 2;
            }
        }
        return ['results' => $results, 'page' => (int)($data['page'] ?? 1), 'totalPages' => min(100, (int)($data['total_pages'] ?? 1)),
            'totalCount' => (int)($data['total_count'] ?? count($results)), 'moviehash' => $hash];
    }

    public function download(string $uid, int $fileId): array {
        if ($fileId <= 0) throw new ApiException('invalid_file_id');
        $value = $this->connection($uid);
        // This call consumes the user's download allowance. Never retry it automatically.
        $data = $this->request('POST', $value['base'], 'download', $this->apiKey($value), $value['token'], ['file_id' => $fileId, 'sub_format' => 'srt']);
        $url = self::downloadUrl((string)($data['link'] ?? ''));
        $client = $this->clients->newClient();
        try {
            for ($hop = 0; ; $hop++) {
                // Never forward the API key or bearer token to a subtitle download URL.
                $response = $client->get($url, ['headers' => ['User-Agent' => self::AGENT, 'Accept' => 'text/plain'],
                    'timeout' => 20, 'connect_timeout' => 8, 'allow_redirects' => false, 'http_errors' => false, 'stream' => true]);
                if (!in_array($response->getStatusCode(), [301, 302, 303, 307, 308], true)) break;
                if ($hop >= 2) throw new ApiException('download_redirect', 502);
                $location = $response->getHeader('Location');
                if (str_starts_with($location, '/') && !str_starts_with($location, '//')) {
                    $parts = parse_url($url); $location = 'https://' . $parts['host'] . $location;
                }
                self::body($response, 1048576);
                $url = self::downloadUrl($location);
            }
            if ($response->getStatusCode() !== 200) throw new ApiException('download_failed', 502);
            $text = self::body($response, self::MAX_SUBTITLE);
            if ($text === '' || preg_match('//u', $text) !== 1) throw new ApiException('invalid_subtitle', 502);
        } catch (ApiException $e) { throw $e; }
        catch (\Throwable) { throw new ApiException('download_failed', 502); }
        return ['text' => $text, 'fileName' => basename(str_replace('\\', '/', (string)($data['file_name'] ?? 'subtitle.srt'))),
            'remaining' => isset($data['remaining']) ? max(0, (int)$data['remaining']) : null,
            'resetTime' => substr((string)($data['reset_time_utc'] ?? ''), 0, 80)];
    }
}
