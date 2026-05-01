<?php

use App\Http\Controllers\AgentController;
use App\Http\Controllers\CustomerController;
use App\Http\Controllers\InstallController;
use App\Http\Controllers\SpecController;
use Illuminate\Support\Facades\Route;

Route::get('/healthz', fn () => ['status' => 'ok']);

// v0.1 + v0.2 spec subset that the Hearth SPA hits.
// (Hand-rolled because flametrench/laravel doesn't ship HTTP routes.)
Route::prefix('v1')->group(function () {
    Route::post('/users', [SpecController::class, 'createUser']);
    Route::post('/credentials', [SpecController::class, 'createCredential']);
    Route::post('/credentials/verify', [SpecController::class, 'verifyCredential']);
    Route::post('/sessions', [SpecController::class, 'createSession']);
    Route::middleware('session.bearer')->post('/orgs', [SpecController::class, 'createOrg']);
});

Route::prefix('app')->group(function () {
    // Install (public)
    Route::get('/install/status', [InstallController::class, 'status']);
    Route::post('/install', [InstallController::class, 'install']);

    // Public customer submit
    Route::post('/tickets/submit', [CustomerController::class, 'submit']);

    // Customer flow (share-bearer)
    Route::middleware('share.bearer')->group(function () {
        Route::get('/customer/ticket', [CustomerController::class, 'viewTicket']);
        Route::post('/customer/comment', [CustomerController::class, 'postComment']);
    });

    // Agent flow (session-bearer)
    Route::middleware('session.bearer')->group(function () {
        Route::get('/orgs/{slug}/tickets', [AgentController::class, 'inbox']);
        Route::post('/orgs/{org_id}/settings', [AgentController::class, 'orgSettings']);
        Route::get('/tickets/{ticket_id}', [AgentController::class, 'ticketDetail']);
        Route::post('/tickets/{ticket_id}/comment', [AgentController::class, 'comment']);
        Route::post('/tickets/{ticket_id}/assign', [AgentController::class, 'assign']);
        Route::post('/tickets/{ticket_id}/resolve', [AgentController::class, 'resolve']);
        Route::post('/tickets/{ticket_id}/reopen', [AgentController::class, 'reopen']);
        Route::post('/tickets/{ticket_id}/share', [AgentController::class, 'mintShare']);
        Route::post('/shares/{shr_id}/revoke', [AgentController::class, 'revokeShare']);
    });
});
