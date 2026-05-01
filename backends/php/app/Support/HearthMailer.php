<?php

declare(strict_types=1);

namespace App\Support;

use Illuminate\Support\Facades\Mail;

class HearthMailer
{
    public function shareUrl(string $token): string
    {
        $base = (string) config('hearth.public_base_url', 'http://localhost:3000');

        return rtrim($base, '/').'/share/'.$token;
    }

    public function sendShareLinkEmail(
        string $to,
        string $orgName,
        string $ticketSubject,
        string $shareToken,
    ): void {
        $url = $this->shareUrl($shareToken);
        $subject = 'Your support request — '.$ticketSubject;
        $body = "Thanks for contacting {$orgName}.\n\n"
            ."View your ticket and reply at:\n"
            ."  {$url}\n\n"
            ."This link is valid for 30 days.\n";

        Mail::raw($body, function ($message) use ($to, $subject) {
            $message->to($to)->subject($subject);
        });
    }

    /** @param string[] $admins */
    public function sendCustomerReplyNotification(
        array $admins,
        string $orgName,
        string $ticketSubject,
        string $customerEmail,
        bool $reopened,
    ): void {
        if (count($admins) === 0) {
            return;
        }
        $prefix = $reopened ? 'Ticket reopened by customer reply' : 'New customer reply';
        $subject = $prefix.' — '.$ticketSubject;
        $body = "{$customerEmail} replied to \"{$ticketSubject}\" in {$orgName}.\n"
            .($reopened ? "The ticket was resolved and is now reopened.\n" : '')
            ."\nOpen the ticket in your inbox to respond.\n";

        Mail::raw($body, function ($message) use ($admins, $subject) {
            $message->to($admins)->subject($subject);
        });
    }
}
