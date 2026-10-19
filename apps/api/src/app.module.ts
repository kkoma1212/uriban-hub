import { fileURLToPath } from "node:url";

import { type DynamicModule, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import { AuthModule } from "./auth/auth.module.js";
import { AuditLogsModule } from "./audit-logs/audit-logs.module.js";
import { PublicSystemStateModule } from "./system-state/system-state.module.js";
import { BootstrapModule } from "./bootstrap/bootstrap.module.js";
import { ClassesModule } from "./classes/classes.module.js";
import { ClientErrorsModule } from "./client-errors/client-errors.module.js";
import { LoggingModule } from "./common/logging/logging.module.js";
import { loadEnvironment, type AppEnvironment } from "./config/environment.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthController } from "./health/health.controller.js";
import { HomeModule } from "./home/home.module.js";
import { LegalDocumentsModule } from "./legal/legal-documents.module.js";
import { MealsModule } from "./meals/meals.module.js";
import { MembershipModule } from "./membership/membership.module.js";
import { MembersModule } from "./members/members.module.js";
import { NoticesModule } from "./notices/notices.module.js";
import { HelpRequestsModule } from "./help-requests/help-requests.module.js";
import { SchedulesModule } from "./schedules/schedules.module.js";
import { SchoolsModule } from "./schools/schools.module.js";
import { SuppliesModule } from "./supplies/supplies.module.js";
import { UpdatesModule } from "./updates/updates.module.js";

const ENV_FILE_PATHS = [
  fileURLToPath(new URL("../../../.env.local", import.meta.url)),
  fileURLToPath(new URL("../../../.env", import.meta.url)),
];

interface AppModuleConfiguration {
  environment: AppEnvironment;
  module: DynamicModule;
}

export function shouldIgnoreAppEnvironmentFiles(
  explicitNodeEnvironment: string | undefined,
  hasEnvironmentOverride: boolean,
): boolean {
  return (
    hasEnvironmentOverride ||
    explicitNodeEnvironment === "production" ||
    explicitNodeEnvironment === "test"
  );
}

@Module({})
export class AppModule {
  static async configure(environmentOverride?: AppEnvironment): Promise<AppModuleConfiguration> {
    let environment: AppEnvironment | undefined;
    const useOverride = environmentOverride !== undefined;
    const ignoreEnvironmentFiles = shouldIgnoreAppEnvironmentFiles(
      process.env.NODE_ENV,
      useOverride,
    );
    const configurationModule = await ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ENV_FILE_PATHS,
      ignoreEnvFile: ignoreEnvironmentFiles,
      ignoreEnvVars: useOverride,
      skipProcessEnv: useOverride,
      validate: (input: Record<string, unknown>) => {
        environment = environmentOverride ?? loadEnvironment(input);
        return environment;
      },
    });

    if (environment === undefined) {
      throw new Error("환경 설정을 불러오지 못했습니다.");
    }

    // API_SURFACE=admin(관리자 프로그램)은 학생·교사 기능 묶음을 싣지 않는다(T-ADMIN-SPLIT 3단계).
    // 로그인 기반·DB·감사·화면 오류 기록·약관 읽기는 관리자 기능도 쓰므로 공통으로 싣는다.
    const servesUserFeatures = environment.API_SURFACE !== "admin";
    const imports = [
      configurationModule,
      DatabaseModule,
      LoggingModule,
      AuthModule,
      AuditLogsModule,
      ClientErrorsModule,
      LegalDocumentsModule,
      ...(servesUserFeatures
        ? [
            PublicSystemStateModule,
            BootstrapModule,
            ClassesModule,
            MealsModule,
            MembershipModule,
            MembersModule,
            HelpRequestsModule,
            HomeModule,
            NoticesModule,
            SchedulesModule,
            SchoolsModule,
            SuppliesModule,
            UpdatesModule,
          ]
        : []),
    ];

    if (servesUserFeatures && environment.ATTENDANCE_NOTIFICATIONS_ENABLED) {
      const { AttendanceNotificationsModule } =
        await import("./attendance-notifications/attendance-notifications.module.js");
      imports.push(AttendanceNotificationsModule);
    }

    if (servesUserFeatures && environment.STUDENT_ASSESSMENTS_ENABLED) {
      const { StudentAssessmentsModule } =
        await import("./student-assessments/student-assessments.module.js");
      imports.push(StudentAssessmentsModule);
    }

    if (servesUserFeatures && environment.POLLS_ENABLED) {
      const { PollsModule } = await import("./polls/polls.module.js");
      imports.push(PollsModule);
    }

    if (servesUserFeatures && environment.WEB_PUSH_ENABLED) {
      const { PushSubscriptionsModule } =
        await import("./push-subscriptions/push-subscriptions.module.js");
      imports.push(PushSubscriptionsModule);
    }

    // 2026-09-07 제품 결정(P-016): 자리·모둠·당번과 전용 임시저장·템플릿은
    // 제공하지 않는다. 이전 환경의 기능 스위치가 남아 있어도 모듈을 등록하지 않는다.

    if (servesUserFeatures && environment.CLASS_CHAT_ENABLED) {
      const { ClassChatModule } = await import("./class-chat/class-chat.module.js");
      imports.push(ClassChatModule);
    }

    if (servesUserFeatures && environment.PROFILE_PHOTOS_ENABLED) {
      const { ProfilePhotosModule } = await import("./profile-photos/profile-photos.module.js");
      imports.push(ProfilePhotosModule);
    }

    if (servesUserFeatures && environment.ELECTIONS_ENABLED) {
      const { ElectionsModule } = await import("./elections/elections.module.js");
      imports.push(ElectionsModule);
    }

    if (environment.ADMIN_WEB_ENABLED) {
      const { AdminAuthModule } = await import("./admin-auth/admin-auth.module.js");
      imports.push(AdminAuthModule);
      const { AdminAccountsModule } = await import("./admin-accounts/admin-accounts.module.js");
      imports.push(AdminAccountsModule);
      const { AdminSignupApprovalModule } =
        await import("./admin-signup-approval/admin-signup-approval.module.js");
      imports.push(AdminSignupApprovalModule);
      const { AdminManagementModule } =
        await import("./admin-management/admin-management.module.js");
      imports.push(AdminManagementModule);
      // 2026-09-26 사용자 결정: 시범 동안 서비스 안 문의 접수 창구를 닫고 문의·권리행사는
      // 이메일로만 받는다(사용자 화면 없음·접수 0건). 다시 열려면 항목·보유기간을 처리방침에
      // 확정한 뒤 SupportInquiriesModule 등록을 되살린다.
    }

    if (
      servesUserFeatures &&
      environment.NODE_ENV === "development" &&
      environment.LOCAL_TEST_ADMIN_ENABLED
    ) {
      const { LocalTestAdminModule } =
        await import("./local-test-admin/local-test-admin.module.js");
      imports.push(LocalTestAdminModule);
    }

    return {
      environment,
      module: {
        module: AppModule,
        imports,
        controllers: [HealthController],
      },
    };
  }
}
