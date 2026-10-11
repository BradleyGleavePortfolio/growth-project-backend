-- Reverse of 20270409000000_coach_package_close_public_read. Only for a
-- confirmed defect: it lets the public app key read every package row again.

CREATE POLICY "coach_package_client_select" ON "CoachPackage"
  FOR SELECT USING (true);
