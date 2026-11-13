# Lighthouse Fund sign-up emails

Supabase sends these emails. To brand them, open the Supabase dashboard, go to
**Authentication**, then **Emails** (called **Email Templates** in some versions),
pick each template below, replace the **Subject** and the **Message body** with the
text here, and press **Save**. Do not change anything inside `{{ }}`: Supabase fills
those in.

The sender still shows as Supabase until the fund has its own domain and email
service. That is a separate setup step.

---

## 1. Confirm signup

**Subject**

```
Confirm your Lighthouse Fund account
```

**Message body**

```html
<div style="background:#f3f4f6;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;color:#16181d">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">
    <div style="background:#16181d;padding:22px 28px">
      <div style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.02em"><span style="color:#e2445c">LIGHTHOUSE</span> FUND</div>
      <div style="color:#b9bdc6;font-size:12px;margin-top:4px">An AFSA initiative · Macquarie University</div>
    </div>
    <div style="padding:28px">
      <h1 style="font-size:20px;margin:0 0 12px">Confirm your email address</h1>
      <p style="font-size:15px;line-height:1.6;margin:0 0 22px;color:#3d424b">Thanks for creating an account with the Lighthouse Fund. Press the button below to confirm this is your email address and finish setting up.</p>
      <p style="margin:0 0 22px"><a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#9e1b32;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:9px">Confirm my account</a></p>
      <p style="font-size:13px;line-height:1.6;margin:0;color:#6b7280">New accounts can view the fund. The Fund Manager decides who can place trades. If you did not create this account, you can ignore this email.</p>
    </div>
    <div style="padding:16px 28px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.6;color:#6b7280">The Lighthouse Fund is a simulated student portfolio. No real money is invested and nothing in it is financial advice. Questions: secretary.muafs@gmail.com</div>
  </div>
</div>
```

---

## 2. Reset password

**Subject**

```
Reset your Lighthouse Fund password
```

**Message body**

```html
<div style="background:#f3f4f6;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;color:#16181d">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">
    <div style="background:#16181d;padding:22px 28px">
      <div style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.02em"><span style="color:#e2445c">LIGHTHOUSE</span> FUND</div>
      <div style="color:#b9bdc6;font-size:12px;margin-top:4px">An AFSA initiative · Macquarie University</div>
    </div>
    <div style="padding:28px">
      <h1 style="font-size:20px;margin:0 0 12px">Reset your password</h1>
      <p style="font-size:15px;line-height:1.6;margin:0 0 22px;color:#3d424b">Someone asked to reset the password for your Lighthouse Fund account. Press the button below to choose a new one.</p>
      <p style="margin:0 0 22px"><a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#9e1b32;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:9px">Choose a new password</a></p>
      <p style="font-size:13px;line-height:1.6;margin:0;color:#6b7280">If this was not you, ignore this email and your password stays the same.</p>
    </div>
    <div style="padding:16px 28px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.6;color:#6b7280">The Lighthouse Fund is a simulated student portfolio run by AFSA at Macquarie University. Questions: secretary.muafs@gmail.com</div>
  </div>
</div>
```

---

## 3. Change email address

**Subject**

```
Confirm your new email for the Lighthouse Fund
```

**Message body**

```html
<div style="background:#f3f4f6;padding:32px 16px;font-family:Arial,Helvetica,sans-serif;color:#16181d">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">
    <div style="background:#16181d;padding:22px 28px">
      <div style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.02em"><span style="color:#e2445c">LIGHTHOUSE</span> FUND</div>
      <div style="color:#b9bdc6;font-size:12px;margin-top:4px">An AFSA initiative · Macquarie University</div>
    </div>
    <div style="padding:28px">
      <h1 style="font-size:20px;margin:0 0 12px">Confirm your new email address</h1>
      <p style="font-size:15px;line-height:1.6;margin:0 0 22px;color:#3d424b">You asked to change the email on your Lighthouse Fund account from {{ .Email }} to {{ .NewEmail }}. Press the button below to confirm the change.</p>
      <p style="margin:0 0 22px"><a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#9e1b32;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:9px">Confirm new email</a></p>
      <p style="font-size:13px;line-height:1.6;margin:0;color:#6b7280">If this was not you, ignore this email and nothing changes.</p>
    </div>
    <div style="padding:16px 28px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.6;color:#6b7280">The Lighthouse Fund is a simulated student portfolio run by AFSA at Macquarie University. Questions: secretary.muafs@gmail.com</div>
  </div>
</div>
```
