<?php
declare(strict_types=1);
// SPDX-License-Identifier: AGPL-3.0-or-later
namespace OCA\VideoSubtitles\Service;

use OCP\Constants;
use OCP\Files\Folder;
use OCP\IConfig;
use OCP\Share\IShare;

final class PublicLinkService {
    public function __construct(private IConfig $config) {
    }

    public function enabled(): bool {
        return $this->config->getAppValue('videosubtitles', 'public_links_enabled', '0') === '1';
    }

    public function configure(bool $enabled): void {
        $this->config->setAppValue('videosubtitles', 'public_links_enabled', $enabled ? '1' : '0');
    }

    public function state(IShare $share): array {
        $permissions = $share->getPermissions();
        $writes = Constants::PERMISSION_UPDATE | Constants::PERMISSION_CREATE | Constants::PERMISSION_DELETE;
        $eligible = $share->getShareType() === IShare::TYPE_LINK
            && ($permissions & Constants::PERMISSION_READ) !== 0 && ($permissions & $writes) === 0;
        $node = $share->getNode();
        return ['enabled' => $this->enabled() && $eligible, 'token' => $share->getToken(),
            'isFolder' => $node instanceof Folder, 'name' => $node->getName()];
    }
}
