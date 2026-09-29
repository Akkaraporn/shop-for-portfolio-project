import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';

import { AuthService } from './auth.service';
import type { AuthSession, AuthenticatedUser, TokenPair, UserView } from './auth.types';
import { CurrentUser } from './decorators/current-user.decorator';
import { OptionalAuth, Public } from './decorators/public.decorator';
import { LoginDto } from './dto/login.dto';
import { LogoutDto, RefreshDto } from './dto/refresh.dto';
import { RegisterDto } from './dto/register.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * Creates an account and signs it in, returning the same payload as login so the
   * client never needs two calls.
   *
   * `X-Cart-Token` is read directly rather than through a DTO because it is a
   * header, and because it is entirely optional — a caller who has never had a
   * basket sends nothing.
   */
  @Post('register')
  @Public()
  @HttpCode(HttpStatus.CREATED)
  register(
    @Body() dto: RegisterDto,
    @Headers('x-cart-token') cartToken?: string,
  ): Promise<AuthSession> {
    return this.auth.register(dto, cartToken);
  }

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  login(
    @Body() dto: LoginDto,
    @Headers('x-cart-token') cartToken?: string,
  ): Promise<AuthSession> {
    return this.auth.login(dto, cartToken);
  }

  /**
   * Rotates the refresh token. Public because the access token is expected to have
   * expired by the time a client calls this — requiring a valid one would make the
   * endpoint useless exactly when it is needed.
   */
  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto): Promise<TokenPair> {
    return this.auth.refresh(dto.refreshToken);
  }

  /**
   * Always 204, including when there was nothing to revoke.
   *
   * `@OptionalAuth` rather than `@Public`: a bearer token is used when present, so a
   * caller who lost their refresh token can still end every session for their
   * account, but its absence is not an error.
   */
  @Post('logout')
  @OptionalAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Body() dto: LogoutDto,
    @CurrentUser() user?: AuthenticatedUser,
  ): Promise<void> {
    await this.auth.logout({ refreshToken: dto.refreshToken, userId: user?.id });
  }

  /** Requires a valid access token: the global guard protects anything unannotated. */
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): Promise<UserView> {
    return this.auth.currentUser(user.id);
  }
}
