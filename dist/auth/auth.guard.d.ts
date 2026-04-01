import { CanActivate, ExecutionContext } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
export declare class JwtAuthGuard implements CanActivate {
    private prisma;
    private supabaseService;
    constructor(prisma: PrismaService, supabaseService: SupabaseService);
    canActivate(context: ExecutionContext): Promise<boolean>;
}
