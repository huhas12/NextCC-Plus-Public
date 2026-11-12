<?php
declare(strict_types=1);
// SPDX-License-Identifier: AGPL-3.0-or-later
namespace OCA\VideoSubtitles\Controller;

use OCA\VideoSubtitles\Service\ApiException;
use OCA\VideoSubtitles\Service\MovieHashService;
use OCA\VideoSubtitles\Service\OpenSubtitlesService;
use OCA\VideoSubtitles\Service\PreferenceService;
use OCA\VideoSubtitles\Service\PublicLinkService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\UserRateLimit;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;
use OCP\IUserSession;
use OCP\IGroupManager;

final class ApiController extends Controller {
    public function __construct(IRequest $request, private IUserSession $session, private PreferenceService $prefs,
        private OpenSubtitlesService $subtitles, private MovieHashService $hashes, private IGroupManager $groups,
        private PublicLinkService $publicLinks) {
        parent::__construct('videosubtitles', $request);
    }

    private function uid(): string {
        $user = $this->session->getUser();
        if ($user === null) throw new ApiException('not_authenticated', 401);
        return $user->getUID();
    }

    private function respond(callable $callback): DataResponse {
        $headers = ['Cache-Control' => 'private, no-store', 'X-Content-Type-Options' => 'nosniff'];
        try { return new DataResponse(['ok' => true] + $callback(), 200, $headers); }
        catch (ApiException $e) { return new DataResponse(['ok' => false, 'error' => $e->reason], $e->status, $headers); }
        catch (\Throwable) { return new DataResponse(['ok' => false, 'error' => 'internal_error'], 500, $headers); }
    }

    #[NoAdminRequired]
    #[NoCSRFRequired]
    public function settings(): DataResponse {
        return $this->respond(function () {
            $uid = $this->uid();
            return ['preferences' => $this->prefs->get($uid), 'connection' => $this->subtitles->status($uid),
                'canConfigureApplicationKey' => $this->groups->isAdmin($uid), 'publicLinksEnabled' => $this->publicLinks->enabled()];
        });
    }

    #[UserRateLimit(limit: 10, period: 300)]
    public function configurePublicLinks(bool $enabled = false): DataResponse {
        return $this->respond(function () use ($enabled) {
            $uid = $this->uid();
            if (!$this->groups->isAdmin($uid)) throw new ApiException('administrator_required', 403);
            $this->publicLinks->configure($enabled);
            return ['publicLinksEnabled' => $this->publicLinks->enabled()];
        });
    }

    // The framework's default administrator and CSRF checks remain enabled.
    #[UserRateLimit(limit: 5, period: 300)]
    public function configureApplication(string $apiKey = '', bool $clear = false): DataResponse {
        return $this->respond(function () use ($apiKey, $clear) {
            $uid = $this->uid();
            if (!$this->groups->isAdmin($uid)) throw new ApiException('administrator_required', 403);
            $this->subtitles->configureApplicationKey($apiKey, $clear);
            return ['connection' => $this->subtitles->status($uid)];
        });
    }

    #[NoAdminRequired]
    #[UserRateLimit(limit: 60, period: 60)]
    public function preferences(array $preferences = []): DataResponse {
        return $this->respond(fn () => ['preferences' => $this->prefs->save($this->uid(), $preferences)]);
    }

    #[NoAdminRequired]
    #[UserRateLimit(limit: 5, period: 300)]
    public function connect(string $username = '', string $password = '', string $apiKey = ''): DataResponse {
        return $this->respond(fn () => ['connection' => $this->subtitles->connect($this->uid(), $username, $password, $apiKey)]);
    }

    #[NoAdminRequired]
    #[UserRateLimit(limit: 10, period: 300)]
    public function disconnect(): DataResponse {
        return $this->respond(fn () => ['connection' => $this->subtitles->disconnect($this->uid())]);
    }

    #[NoAdminRequired]
    #[NoCSRFRequired]
    #[UserRateLimit(limit: 15, period: 60)]
    public function languages(): DataResponse {
        return $this->respond(fn () => ['languages' => $this->subtitles->languages($this->uid())]);
    }

    #[NoAdminRequired]
    #[UserRateLimit(limit: 30, period: 60)]
    public function search(string $query = '', array $languages = [], string $mode = 'name', string $videoPath = '',
        int $page = 1, int $year = 0, int $season = 0, int $episode = 0): DataResponse {
        return $this->respond(function () use ($query, $languages, $mode, $videoPath, $page, $year, $season, $episode) {
            $uid = $this->uid();
            if (!in_array($mode, ['name', 'hash'], true)) throw new ApiException('invalid_query');
            $hash = $mode === 'hash' ? $this->hashes->calculate($uid, $videoPath)['hash'] : '';
            return $this->subtitles->search($uid, $query, $languages, $hash, $page, $year, $season, $episode);
        });
    }

    #[NoAdminRequired]
    #[UserRateLimit(limit: 20, period: 60)]
    public function download(int $fileId = 0): DataResponse {
        return $this->respond(fn () => $this->subtitles->download($this->uid(), $fileId));
    }
}
