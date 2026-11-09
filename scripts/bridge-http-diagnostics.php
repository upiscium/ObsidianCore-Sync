<?php
// Fixture-only instrumentation; never copied into the production companion app.
register_shutdown_function(static function (): void {
    if (!str_starts_with($_SERVER['REQUEST_URI'] ?? '', '/ocs/')) return;
    $result = ['uri' => $_SERVER['REQUEST_URI'], 'script' => $_SERVER['SCRIPT_NAME'] ?? null, 'pathInfo' => $_SERVER['PATH_INFO'] ?? null];
    try {
        $result['rawPathInfo'] = \OCP\Server::get(\OCP\IRequest::class)->getRawPathInfo();
        $result['uid'] = \OCP\Server::get(\OCP\IUserSession::class)->getUser()?->getUID();
        $result['enabled'] = \OCP\Server::get(\OCP\App\IAppManager::class)->isEnabledForUser('vaultsync_bridge');
        $app = new \OCA\VaultSyncBridge\AppInfo\Application();
        $controller = $app->getContainer()->get(\OCA\VaultSyncBridge\Controller\ApiController::class);
        $result['controller'] = get_class($controller);
    } catch (Throwable $e) {
        $result['error'] = get_class($e) . ': ' . $e->getMessage();
        $result['stack'] = $e->getTraceAsString();
    }
    error_log('VAULTSYNC_HTTP_DIAGNOSTIC ' . json_encode($result, JSON_UNESCAPED_SLASHES));
});
