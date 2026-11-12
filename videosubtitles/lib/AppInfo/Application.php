<?php
declare(strict_types=1);

namespace OCA\VideoSubtitles\AppInfo;

use OCA\Files\Event\LoadAdditionalScriptsEvent;
use OCA\VideoSubtitles\Listener\LoadPlayer;
use OCA\Viewer\Event\LoadViewer;
use OCA\Files_Sharing\Event\BeforeTemplateRenderedEvent;
use OCP\AppFramework\App;
use OCP\AppFramework\Bootstrap\IBootContext;
use OCP\AppFramework\Bootstrap\IBootstrap;
use OCP\AppFramework\Bootstrap\IRegistrationContext;

final class Application extends App implements IBootstrap {
    public const APP_ID = 'videosubtitles';

    public function __construct() {
        parent::__construct(self::APP_ID);
    }

    public function register(IRegistrationContext $context): void {
        $context->registerEventListener(LoadAdditionalScriptsEvent::class, LoadPlayer::class);
        $context->registerEventListener(LoadViewer::class, LoadPlayer::class);
        $context->registerEventListener(BeforeTemplateRenderedEvent::class, LoadPlayer::class);
    }

    public function boot(IBootContext $context): void {
    }
}
