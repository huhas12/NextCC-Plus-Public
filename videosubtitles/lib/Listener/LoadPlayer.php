<?php
declare(strict_types=1);

namespace OCA\VideoSubtitles\Listener;

use OCA\VideoSubtitles\AppInfo\Application;
use OCA\Files_Sharing\Event\BeforeTemplateRenderedEvent;
use OCA\VideoSubtitles\Service\PublicLinkService;
use OCP\AppFramework\Services\IInitialState;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\IUserSession;
use OCP\Util;

/** @implements IEventListener<Event> */
final class LoadPlayer implements IEventListener {
    private static bool $loaded = false;

    public function __construct(private IUserSession $userSession, private PublicLinkService $publicLinks,
        private IInitialState $initialState) {
    }

    public function handle(Event $event): void {
        if ($event instanceof BeforeTemplateRenderedEvent) {
            // The normal share view has a null scope; never inject on a password/auth page.
            if ($event->getScope() !== null) return;
            try { $state = $this->publicLinks->state($event->getShare()); }
            catch (\Throwable) { $state = ['enabled' => false]; }
            // Provide the public context even when another event already queued the scripts
            // for a signed-in visitor. Public views must never use that visitor's private API.
            $this->initialState->provideInitialState('public', $state);
            if (!$state['enabled']) return;
        } elseif ($this->userSession->getUser() === null) {
            return;
        }
        if (self::$loaded) return;
        self::$loaded = true;
        Util::addScript(Application::APP_ID, 'subtitle-core');
        Util::addScript(Application::APP_ID, 'subtitle-options');
        Util::addScript(Application::APP_ID, 'subtitle-ui');
        Util::addScript(Application::APP_ID, 'player');
        Util::addStyle(Application::APP_ID, 'player');
    }
}
